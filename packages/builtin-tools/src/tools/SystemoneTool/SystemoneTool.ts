import { createHash } from 'node:crypto'
import axios from 'axios'
import { z } from 'zod/v4'
import type { ToolResultBlockParam, ToolUseContext, Tool } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { getSessionId } from 'src/bootstrap/state.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { AbortError } from 'src/utils/errors.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { checkReadPermissionForTool } from 'src/utils/permissions/filesystem.js'
import { getAskRules, getDenyRules } from 'src/utils/permissions/permissions.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import type {
  PermissionDecision,
  PermissionUpdate,
} from 'src/types/permissions.js'
import { resolveSystemoneEndpoint, systemoneTimeoutMs } from './config.js'
import {
  SYSTEMONE_CONTEXT_CACHE_BYTES,
  SYSTEMONE_CONTEXT_CACHE_ENTRIES,
  SYSTEMONE_MAX_IMAGES,
  SYSTEMONE_MAX_REQUEST_BYTES,
  SYSTEMONE_MAX_RESPONSE_BYTES,
  SYSTEMONE_MAX_XML_BYTES,
  SYSTEMONE_TOOL_NAME,
} from './constants.js'
import { expandImageSource, isDataUrl, resolveImageSources } from './images.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import { expandStateSource, readStateFile } from './state.js'
import { parseSystemoneXml } from './xml.js'

const instructionsSchema = z
  .unknown()
  .refine(value => value !== undefined && value !== null, {
    message: 'instructions is required',
  })

const choiceQuestionSchema = z.strictObject({
  type: z.literal('choice'),
  instructions: instructionsSchema,
  criteria: z.record(z.string(), z.unknown()).refine(
    criteria => {
      const count = Object.keys(criteria).length
      return count >= 1 && count <= 52
    },
    { message: 'choice criteria must contain 1-52 options' },
  ),
})

const scoreQuestionSchema = z.strictObject({
  type: z.literal('score'),
  instructions: instructionsSchema,
  criteria: z.array(z.unknown()).min(2).max(10),
})

const noulQuestionSchema = z.strictObject({
  type: z.literal('noul'),
  instructions: instructionsSchema,
  criteria: z
    .strictObject({
      true: z.unknown().optional(),
      false: z.unknown().optional(),
    })
    .optional(),
})

const questionSchema = z.discriminatedUnion('type', [
  choiceQuestionSchema,
  scoreQuestionSchema,
  noulQuestionSchema,
])

const stateSchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
])

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      request_xml: z
        .string()
        .min(1)
        .max(SYSTEMONE_MAX_XML_BYTES)
        .optional()
        .describe(
          'XML form: <systemone state_path="..."><question id="q" type="noul">...</question></systemone>. Alternative to the structured fields; do not combine them.',
        ),
      state: stateSchema
        .optional()
        .describe(
          'The context to evaluate. Provide it, state_path, or images on the first call for a context_id.',
        ),
      state_path: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          'Local file whose exact text becomes state. Preferred over pasting a file context into state. Cached and resent on context_id follow-ups.',
        ),
      context_id: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe(
          'Stable id for prefix reuse. After a call that returned one, pass it alone (omit state) for follow-ups about the same context.',
        ),
      questions: z
        .record(z.string(), questionSchema)
        .refine(
          questions => {
            const count = Object.keys(questions).length
            return count >= 1 && count <= 64
          },
          { message: 'questions must contain 1-64 entries' },
        )
        .optional()
        .describe(
          'Question id -> question. Batch every question about the same state into this one call. Required unless request_xml is provided.',
        ),
      files: z
        .array(z.string())
        .max(8)
        .optional()
        .describe(
          'Image sources: local file paths (preferred) or image data URLs. The tool reads and encodes paths itself. Cached with the context and resent automatically on context_id follow-ups.',
        ),
      images: z
        .array(z.string())
        .max(8)
        .optional()
        .describe(
          'Alias of files: local image paths (preferred) or image data URLs. Cached and resent on follow-ups.',
        ),
      temperature: z
        .number()
        .positive()
        .optional()
        .describe(
          'Softmax temperature over the option scores; default 1. Higher flattens the distribution.',
        ),
    })
    .superRefine((value, ctx) => {
      if (value.request_xml !== undefined) {
        const extras = (
          [
            'state',
            'state_path',
            'context_id',
            'questions',
            'files',
            'images',
            'temperature',
          ] as const
        ).filter(key => value[key] !== undefined)
        if (extras.length > 0) {
          ctx.addIssue({
            code: 'custom',
            message: `request_xml cannot be combined with ${extras.join(', ')}`,
          })
        }
        return
      }
      if (value.questions === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'questions is required unless request_xml is provided',
        })
      }
      const imageCount =
        (value.files?.length ?? 0) + (value.images?.length ?? 0)
      if (value.state !== undefined && value.state_path !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'Provide either state or state_path, not both',
        })
      }
      if (
        value.state === undefined &&
        value.state_path === undefined &&
        value.context_id === undefined &&
        imageCount === 0
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Provide state, state_path, or images on the first call, or a context_id returned by a previous call',
        })
      }
      if (imageCount > 8) {
        ctx.addIssue({
          code: 'custom',
          message: 'At most 8 images total across files and images',
        })
      }
    }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    status: z.number(),
    body: z.unknown().optional(),
    error: z.string().optional(),
    context_id: z.string().optional(),
    notice: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

type State = string | Record<string, unknown> | unknown[]
type ContextMedia = { files?: string[]; images?: string[] }
type CachedContext = ContextMedia & { state: State; bytes: number }

// Session-scoped LRU. Storing the state and its images guarantees that
// follow-ups resend the exact bytes ninfer needs to restore its prefix, while
// keying by session ID prevents cross-session leakage in long-lived processes.
const contextCache = new Map<string, CachedContext>()
let contextCacheBytes = 0

function scopedContextKey(id: string): string {
  return `${getSessionId()}\u0000${id}`
}

export function clearSystemoneContextCache(): void {
  contextCache.clear()
  contextCacheBytes = 0
}

function serializedState(state: State): string {
  return typeof state === 'string' ? state : JSON.stringify(state)
}

function stateBytes(state: State): number {
  return Buffer.byteLength(serializedState(state), 'utf8')
}

function mediaBytes(media: ContextMedia): number {
  let bytes = 0
  for (const data of media.files ?? []) {
    bytes += Buffer.byteLength(data, 'utf8')
  }
  for (const data of media.images ?? []) {
    bytes += Buffer.byteLength(data, 'utf8')
  }
  return bytes
}

function cloneState(state: State): State {
  return typeof state === 'string'
    ? state
    : (JSON.parse(JSON.stringify(state)) as State)
}

function cloneMedia(media: ContextMedia): ContextMedia {
  return {
    ...(media.files === undefined ? {} : { files: [...media.files] }),
    ...(media.images === undefined ? {} : { images: [...media.images] }),
  }
}

function autoContextId(state: State, media: ContextMedia): string {
  const hash = createHash('sha256').update(serializedState(state))
  for (const data of media.files ?? []) {
    hash.update(`\u0000file\u0000${data}`)
  }
  for (const data of media.images ?? []) {
    hash.update(`\u0000image\u0000${data}`)
  }
  return `systemone-${hash.digest('hex').slice(0, 12)}`
}

function rememberContext(
  id: string,
  state: State,
  media: ContextMedia,
): boolean {
  const key = scopedContextKey(id)
  const bytes = stateBytes(state) + mediaBytes(media)
  const existing = contextCache.get(key)
  if (existing !== undefined) {
    contextCache.delete(key)
    contextCacheBytes -= existing.bytes
  }
  if (bytes > SYSTEMONE_CONTEXT_CACHE_BYTES) {
    return false
  }
  contextCache.set(key, {
    state: cloneState(state),
    ...cloneMedia(media),
    bytes,
  })
  contextCacheBytes += bytes
  while (
    contextCache.size > SYSTEMONE_CONTEXT_CACHE_ENTRIES ||
    contextCacheBytes > SYSTEMONE_CONTEXT_CACHE_BYTES
  ) {
    const oldest = contextCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    const evicted = contextCache.get(oldest)
    contextCache.delete(oldest)
    if (evicted !== undefined) {
      contextCacheBytes -= evicted.bytes
    }
  }
  return contextCache.has(key)
}

function recallContext(
  id: string,
): { state: State; media: ContextMedia } | undefined {
  const key = scopedContextKey(id)
  const cached = contextCache.get(key)
  if (cached === undefined) {
    return undefined
  }
  // Refresh LRU position.
  contextCache.delete(key)
  contextCache.set(key, cached)
  return { state: cloneState(cached.state), media: cloneMedia(cached) }
}

function sanitizeUrlForError(raw: string): string {
  try {
    const parsed = new URL(raw)
    if (parsed.username || parsed.password) {
      parsed.username = '***'
      parsed.password = ''
    }
    return parsed.toString()
  } catch {
    return raw
  }
}

function extractError(data: unknown): string {
  if (data !== null && typeof data === 'object') {
    const error = (data as { error?: unknown }).error
    if (error !== null && typeof error === 'object') {
      const message = (error as { message?: unknown }).message
      const code = (error as { code?: unknown }).code
      if (typeof message === 'string' && message.trim()) {
        return typeof code === 'string' ? `${message} (${code})` : message
      }
    }
    if (typeof error === 'string' && error.trim()) {
      return error
    }
  }
  if (typeof data === 'string') {
    return data.trim() || 'Empty error response'
  }
  if (data === undefined || data === null) {
    return 'Empty error response'
  }
  return jsonStringify(data) || 'Unknown error response'
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function localError(message: string): { data: Output } {
  return { data: { status: 400, error: message } }
}

function readPathSources(input: Input): string[] {
  let source: {
    state_path?: string
    files?: string[]
    images?: string[]
  } = input
  if (input.request_xml !== undefined) {
    try {
      source = parseSystemoneXml(input.request_xml)
    } catch {
      // call() rejects malformed XML before reading any file.
      return []
    }
  }
  const paths = [...(source.files ?? []), ...(source.images ?? [])]
    .filter(value => !isDataUrl(value))
    .map(expandImageSource)
  if (source.state_path !== undefined) {
    paths.push(expandStateSource(source.state_path))
  }
  return paths
}

/**
 * A deny on any image path wins. Otherwise the first single ask is returned
 * intact; multiple asks are combined so the prompt names every path.
 */
export function combineImagePermissionDecisions(
  decisions: PermissionDecision[],
): PermissionDecision | undefined {
  const askMessages: string[] = []
  const suggestions: PermissionUpdate[] = []
  let singleAsk: PermissionDecision | undefined
  let ruleAskReason: PermissionDecision['decisionReason']
  let firstAskReason: PermissionDecision['decisionReason']
  let askCount = 0
  for (const decision of decisions) {
    if (decision.behavior === 'deny') {
      return decision
    }
    if (decision.behavior === 'ask') {
      askCount += 1
      singleAsk = decision
      askMessages.push(decision.message)
      if (decision.suggestions) {
        suggestions.push(...decision.suggestions)
      }
      if (decision.decisionReason) {
        if (firstAskReason === undefined) {
          firstAskReason = decision.decisionReason
        }
        // Preserve bypass-immune rule-based ask reasons (e.g. Read(.env))
        // so pairing an ask-ruled path with another out-of-workdir path never
        // strips decisionReason and bypasses confirmation.
        if (
          ruleAskReason === undefined &&
          decision.decisionReason.type === 'rule' &&
          decision.decisionReason.rule.ruleBehavior === 'ask'
        ) {
          ruleAskReason = decision.decisionReason
        }
      }
    }
  }
  if (askCount === 0) {
    return undefined
  }
  if (askCount === 1) {
    return singleAsk
  }
  const decisionReason = ruleAskReason ?? firstAskReason
  return {
    behavior: 'ask',
    message: [...new Set(askMessages)].join('\n'),
    ...(decisionReason !== undefined ? { decisionReason } : {}),
    ...(suggestions.length > 0 ? { suggestions } : {}),
  }
}

export const SystemoneTool = buildTool({
  name: SYSTEMONE_TOOL_NAME,
  searchHint:
    'typed decisions choice score yes-no classify route probabilities ninfer',
  maxResultSizeChars: 100_000,
  // Input schema uses z.record / z.unknown / z.discriminatedUnion which emit
  // propertyNames/oneOf/open additionalProperties incompatible with Anthropic
  // strict tool-use validation.
  strict: false,

  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  isEnabled() {
    return true
  },
  // Serialize calls so a follow-up can restore the prefix its predecessor
  // left resident instead of racing it.
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return true
  },
  backfillObservableInput(input) {
    for (const key of ['files', 'images']) {
      const sources = input[key]
      if (Array.isArray(sources)) {
        input[key] = sources.map(source => {
          if (typeof source !== 'string') return source
          try {
            return expandImageSource(source)
          } catch {
            return source
          }
        })
      }
    }
    if (typeof input.state_path === 'string') {
      try {
        input.state_path = expandStateSource(input.state_path)
      } catch {
        // Leave invalid paths untouched; call()/validateInput rejects them.
      }
    }
  },
  // Reading file paths must honor the same read rules as Read: the model can
  // point this tool at any file, and the bytes end up in the prompt.
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const paths = readPathSources(input)
    if (paths.length === 0) {
      return { behavior: 'allow', updatedInput: input }
    }
    const toolPermissionContext = context.getAppState().toolPermissionContext
    // Honor blanket `Read` deny/ask rules (which have ruleContent === undefined
    // and are not matched by checkReadPermissionForTool's pattern lookup).
    const blanketReadDeny = getDenyRules(toolPermissionContext).find(
      r =>
        r.ruleValue.toolName === 'Read' &&
        r.ruleValue.ruleContent === undefined,
    )
    if (blanketReadDeny) {
      return {
        behavior: 'deny',
        message:
          'Permission to read files has been denied by a Read deny rule.',
        decisionReason: { type: 'rule', rule: blanketReadDeny },
      }
    }
    const decisions: PermissionDecision[] = paths.map(path =>
      checkReadPermissionForTool(
        {
          name: SYSTEMONE_TOOL_NAME,
          getPath: () => path,
        } as unknown as Tool,
        { file_path: path },
        toolPermissionContext,
      ),
    )
    const blanketReadAsk = getAskRules(toolPermissionContext).find(
      r =>
        r.ruleValue.toolName === 'Read' &&
        r.ruleValue.ruleContent === undefined,
    )
    if (blanketReadAsk) {
      decisions.push({
        behavior: 'ask',
        message:
          'Permission to read files requires confirmation by a Read ask rule.',
        decisionReason: { type: 'rule', rule: blanketReadAsk },
      })
    }
    // Check every path: a deny anywhere must win, even when an earlier path
    // only asks. Returning early on ask would let the approved call read a
    // later denied file.
    const decision = combineImagePermissionDecisions(decisions)
    if (decision === undefined) {
      return { behavior: 'allow', updatedInput: input }
    }
    if (decision.behavior === 'deny') {
      return decision
    }
    return { ...decision, updatedInput: input }
  },
  toAutoClassifierInput(input: Input) {
    const paths = readPathSources(input)
    const pathsSuffix =
      paths.length > 0 ? ` paths=[${paths.join(', ').slice(0, 400)}]` : ''
    if (input.request_xml !== undefined) {
      return `Systemone: xml request${pathsSuffix}`
    }
    return `Systemone: ${Object.keys(input.questions ?? {})
      .join(', ')
      .slice(0, 200)}${pathsSuffix}`
  },

  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },

  async call(input: Input, context: ToolUseContext): Promise<{ data: Output }> {
    if (context.abortController.signal.aborted) {
      throw new AbortError()
    }

    let request = input
    if (input.request_xml !== undefined) {
      const extras = (
        [
          'state',
          'state_path',
          'context_id',
          'questions',
          'files',
          'images',
          'temperature',
        ] as const
      ).filter(key => input[key] !== undefined)
      if (extras.length > 0) {
        return localError(
          `request_xml cannot be combined with ${extras.join(', ')}`,
        )
      }
      try {
        const xmlRequest = parseSystemoneXml(input.request_xml)
        const parsed = inputSchema().safeParse(xmlRequest)
        if (!parsed.success) {
          return localError(
            `Invalid request_xml: ${parsed.error.issues.map(issue => issue.message).join('; ')}`,
          )
        }
        request = parsed.data
      } catch (error) {
        return localError(`Invalid request_xml: ${describeError(error)}`)
      }
    }
    const questions = request.questions
    if (questions === undefined) {
      return localError('questions is required unless request_xml is provided')
    }

    let state: State | undefined = request.state
    let contextId = request.context_id
    let recalled: { state: State; media: ContextMedia } | undefined

    if (request.state_path !== undefined) {
      if (state !== undefined) {
        return localError('Provide either state or state_path, not both')
      }
      try {
        state = await readStateFile(
          request.state_path,
          context.abortController.signal,
        )
      } catch (error) {
        if (context.abortController.signal.aborted) {
          throw new AbortError()
        }
        return localError(describeError(error))
      }
    }

    if (state === undefined) {
      const imageCount =
        (request.files?.length ?? 0) + (request.images?.length ?? 0)
      if (contextId === undefined) {
        if (imageCount === 0) {
          return localError(
            'Provide state, state_path, or images on the first call, or a context_id returned by a previous call',
          )
        }
        // An image-only context has no text state; ninfer accepts an empty one.
        state = ''
      } else {
        recalled = recallContext(contextId)
        if (recalled === undefined) {
          if (imageCount > 0) {
            // Allow starting a new image-only context with a caller-supplied context_id.
            state = ''
          } else {
            return localError(
              `Unknown context_id "${contextId}". Pass state or images again to start a new context.`,
            )
          }
        } else {
          state = recalled.state
        }
      }
    }

    let files: string[] | undefined
    let images: string[] | undefined
    try {
      const imageBudget = { usedBytes: 0 }
      files = await resolveImageSources(
        request.files,
        context.abortController.signal,
        imageBudget,
      )
      images = await resolveImageSources(
        request.images,
        context.abortController.signal,
        imageBudget,
      )
    } catch (error) {
      if (context.abortController.signal.aborted) {
        throw new AbortError()
      }
      return localError(describeError(error))
    }

    if (recalled !== undefined) {
      // A context_id follow-up must resend the exact media that shaped the
      // prefix; omitting it changes the prompt and breaks ninfer's reuse.
      files ??= recalled.media.files
      images ??= recalled.media.images
      if ((files?.length ?? 0) + (images?.length ?? 0) > SYSTEMONE_MAX_IMAGES) {
        return localError(
          `Provide at most ${SYSTEMONE_MAX_IMAGES} images across files and images`,
        )
      }
    } else if (contextId === undefined) {
      contextId = autoContextId(state, { files, images })
    }

    const body: Record<string, unknown> = {
      state,
      questions,
    }
    if (files !== undefined) {
      body.files = files
    }
    if (images !== undefined) {
      body.images = images
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    const explicitUrl = process.env.SYSTEMONE_URL?.trim()
    const explicitBase = process.env.SYSTEMONE_BASE_URL?.trim()
    const hasExplicitEndpoint = Boolean(explicitUrl || explicitBase)
    const endpoint = resolveSystemoneEndpoint({
      explicitUrl,
      explicitBase,
      explicitApiKey: process.env.SYSTEMONE_API_KEY,
      provider: hasExplicitEndpoint ? 'firstParty' : getAPIProvider(),
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
      openaiBaseUrl: process.env.OPENAI_BASE_URL,
      geminiBaseUrl: process.env.GEMINI_BASE_URL,
      grokBaseUrl: process.env.GROK_BASE_URL,
      anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      openaiApiKey: process.env.OPENAI_API_KEY,
      geminiApiKey: process.env.GEMINI_API_KEY,
      grokApiKey: process.env.GROK_API_KEY ?? process.env.XAI_API_KEY,
    })
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...endpoint.auth,
    }

    try {
      const response = await axios.post(endpoint.url, body, {
        headers,
        signal: context.abortController.signal,
        timeout: systemoneTimeoutMs(process.env.SYSTEMONE_TIMEOUT_MS),
        validateStatus: () => true,
        maxRedirects: 0,
        maxContentLength: SYSTEMONE_MAX_RESPONSE_BYTES,
        maxBodyLength: SYSTEMONE_MAX_REQUEST_BYTES,
      })
      if (context.abortController.signal.aborted) {
        throw new AbortError()
      }
      if (response.status >= 200 && response.status < 300) {
        if (response.data === null || typeof response.data !== 'object') {
          return {
            data: {
              status: response.status,
              error: `Unexpected non-JSON response from ${sanitizeUrlForError(endpoint.url)}`,
              body: response.data,
            },
          }
        }
        // Only cache the context after the server accepts the request so failed
        // calls never overwrite or evict valid cached contexts.
        const cached =
          contextId !== undefined && state !== undefined
            ? rememberContext(contextId, state, { files, images })
            : false
        const advertisedContextId =
          cached && contextId !== undefined ? contextId : undefined
        const notice =
          contextId !== undefined && !cached
            ? 'The context is too large to cache under context_id; resend state, state_path, and images on follow-up calls.'
            : undefined
        return {
          data: {
            status: response.status,
            body: response.data,
            ...(advertisedContextId !== undefined
              ? { context_id: advertisedContextId }
              : {}),
            ...(notice !== undefined ? { notice } : {}),
          },
        }
      }
      return {
        data: {
          status: response.status,
          error: extractError(response.data),
          body: response.data,
        },
      }
    } catch (error) {
      if (context.abortController.signal.aborted) {
        throw new AbortError()
      }
      return {
        data: {
          status: 0,
          error: `${describeError(error)} (is ninfer-serve running at ${sanitizeUrlForError(endpoint.url)}?)`,
        },
      }
    }
  },

  renderToolUseMessage(input: Partial<Input>) {
    if (input.request_xml !== undefined) {
      return 'Systemone (xml)'
    }
    const count = input.questions ? Object.keys(input.questions).length : 0
    return `Systemone (${count} question${count === 1 ? '' : 's'})`
  },

  mapToolResultToToolResultBlockParam(
    output: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    if (output.error !== undefined) {
      const status = output.status > 0 ? ` (HTTP ${output.status})` : ''
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `Systemone error${status}: ${output.error}`,
        is_error: true,
      }
    }
    const content = jsonStringify(output.body ?? output)
    const hints: string[] = []
    if (output.context_id !== undefined) {
      hints.push(
        `context_id: ${output.context_id}. Reuse this context_id and omit state for follow-up questions about the same context so ninfer can restore its prefix.`,
      )
    }
    if (output.notice !== undefined) {
      hints.push(output.notice)
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        hints.length === 0 ? content : `${content}\n\n[${hints.join(' ')}]`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
