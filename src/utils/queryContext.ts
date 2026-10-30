/**
 * Shared helpers for building the API cache-key prefix (systemPrompt,
 * userContext, systemContext) for query() calls.
 *
 * Lives in its own file because it imports from context.ts and
 * constants/prompts.ts, which are high in the dependency graph. Putting
 * these imports in systemPrompt.ts or sideQuestion.ts (both reachable
 * from commands.ts) would create cycles. Only entrypoint-layer files
 * import from here (QueryEngine.ts, cli/print.ts).
 */

import {
  getProjectRoot,
  getRenderedSystemPrompt,
  getSystemPromptSectionCache,
  setRenderedSystemPrompt,
} from '../bootstrap/state.js'
import type { Command } from '../commands.js'
import { getSystemPrompt } from '../constants/prompts.js'
import { getSystemContext, getUserContext } from '../context.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../services/mcp/types.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Tools, ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../types/message.js'
import { createAbortController } from './abortController.js'
import type { FileStateCache } from './fileStateCache.js'
import type { CacheSafeParams } from './forkedAgent.js'
import { getMainLoopModel } from './model/model.js'
import { recordPromptContext } from './sessionStorage.js'
import { asSystemPrompt } from './systemPromptType.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './thinking.js'

/**
 * Identity of the connected MCP servers that feed the (uncached) instructions
 * section. Only a changed name set can legitimately change that section; the
 * assembled prompt is reused while this key is unchanged.
 */
function connectedMcpKey(
  mcpClients: MCPServerConnection[] | undefined,
): string {
  return (mcpClients ?? [])
    .filter(
      (client): client is ConnectedMCPServer => client.type === 'connected',
    )
    .map(client => client.name)
    .sort()
    .join('\u0000')
}

/**
 * Fetch the three context pieces that form the API cache-key prefix:
 * systemPrompt parts, userContext, systemContext.
 *
 * When customSystemPrompt is set, the default getSystemPrompt build and
 * getSystemContext are skipped — the custom prompt replaces the default
 * entirely, and systemContext would be appended to a default that isn't
 * being used.
 *
 * Callers assemble the final systemPrompt from defaultSystemPrompt (or
 * customSystemPrompt) + optional extras + appendSystemPrompt. QueryEngine
 * injects coordinator userContext and memory-mechanics prompt on top;
 * sideQuestion's fallback uses the base result directly.
 */
/**
 * Render the default system prompt once per render point and reuse those
 * bytes for every later request. Section values are cached individually, but
 * the static sections around them — intro/output-style text, tool guidance,
 * feature gates — are otherwise re-rendered per request, and a resumed
 * process can render them differently. Either case rewrites the leading
 * prompt tokens and forces the inference server to re-prefill the whole
 * conversation, so the assembled bytes win until a render point (/clear,
 * /compact, resume, or a changed MCP server set).
 */
export async function buildDefaultSystemPrompt({
  tools,
  mainLoopModel,
  additionalWorkingDirectories,
  mcpClients,
}: {
  tools: Tools
  mainLoopModel: string
  additionalWorkingDirectories: string[]
  mcpClients: MCPServerConnection[]
}): Promise<string[]> {
  const mcpKey = connectedMcpKey(mcpClients)
  const rendered = getRenderedSystemPrompt()
  if (rendered !== null && rendered.mcpKey === mcpKey) return rendered.parts
  const defaultSystemPrompt = await getSystemPrompt(
    tools,
    mainLoopModel,
    additionalWorkingDirectories,
    mcpClients,
  )
  setRenderedSystemPrompt(defaultSystemPrompt, mcpKey)
  return defaultSystemPrompt
}

/**
 * Record the environment-derived prefix, and the assembled bytes built from
 * it, for a later resume. Only the default-prompt path records: custom
 * prompts (subagents, SDK) replace the default prefix and must not overwrite
 * the main session's snapshot.
 */
export function recordDefaultSystemPromptContext({
  defaultSystemPrompt,
  userContext,
  systemContext,
  mcpClients,
}: {
  defaultSystemPrompt: string[]
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  mcpClients: MCPServerConnection[]
}): void {
  recordPromptContext({
    promptProjectRoot: getProjectRoot(),
    systemPromptSections: Array.from(getSystemPromptSectionCache().entries()),
    userContext,
    systemContext,
    renderedSystemPrompt: defaultSystemPrompt,
    renderedSystemPromptMcpKey: connectedMcpKey(mcpClients),
  })
}

export async function fetchSystemPromptParts({
  tools,
  mainLoopModel,
  additionalWorkingDirectories,
  mcpClients,
  customSystemPrompt,
}: {
  tools: Tools
  mainLoopModel: string
  additionalWorkingDirectories: string[]
  mcpClients: MCPServerConnection[]
  customSystemPrompt: string | undefined
}): Promise<{
  defaultSystemPrompt: string[]
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
}> {
  const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
    customSystemPrompt !== undefined
      ? Promise.resolve([])
      : buildDefaultSystemPrompt({
          tools,
          mainLoopModel,
          additionalWorkingDirectories,
          mcpClients,
        }),
    getUserContext(),
    customSystemPrompt !== undefined ? Promise.resolve({}) : getSystemContext(),
  ])
  if (customSystemPrompt === undefined) {
    recordDefaultSystemPromptContext({
      defaultSystemPrompt,
      userContext,
      systemContext,
      mcpClients,
    })
  }
  return { defaultSystemPrompt, userContext, systemContext }
}

/**
 * Build CacheSafeParams from raw inputs when getLastCacheSafeParams() is null.
 *
 * Used by the SDK side_question handler (print.ts) on resume before a turn
 * completes — there's no stopHooks snapshot yet. Mirrors the system prompt
 * assembly in QueryEngine.ts:ask() so the rebuilt prefix matches what the
 * main loop will send, preserving the cache hit in the common case.
 *
 * May still miss the cache if the main loop applies extras this path doesn't
 * know about (coordinator mode, memory-mechanics prompt). That's acceptable —
 * the alternative is returning null and failing the side question entirely.
 */
export async function buildSideQuestionFallbackParams({
  tools,
  commands,
  mcpClients,
  messages,
  readFileState,
  getAppState,
  setAppState,
  customSystemPrompt,
  appendSystemPrompt,
  thinkingConfig,
  agents,
}: {
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  messages: Message[]
  readFileState: FileStateCache
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  customSystemPrompt: string | undefined
  appendSystemPrompt: string | undefined
  thinkingConfig: ThinkingConfig | undefined
  agents: AgentDefinition[]
}): Promise<CacheSafeParams> {
  const mainLoopModel = getMainLoopModel()
  const appState = getAppState()

  const { defaultSystemPrompt, userContext, systemContext } =
    await fetchSystemPromptParts({
      tools,
      mainLoopModel,
      additionalWorkingDirectories: Array.from(
        appState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt,
    })

  const systemPrompt = asSystemPrompt([
    ...(customSystemPrompt !== undefined
      ? [customSystemPrompt]
      : defaultSystemPrompt),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])

  // Strip in-progress assistant message (stop_reason === null) — same guard
  // as btw.tsx. The SDK can fire side_question mid-turn.
  const last = messages.at(-1)
  const forkContextMessages =
    last?.type === 'assistant' && last.message!.stop_reason === null
      ? messages.slice(0, -1)
      : messages

  const toolUseContext: ToolUseContext = {
    options: {
      commands,
      debug: false,
      mainLoopModel,
      tools,
      verbose: false,
      thinkingConfig:
        thinkingConfig ??
        (shouldEnableThinkingByDefault() !== false
          ? { type: 'adaptive' }
          : { type: 'disabled' }),
      mcpClients,
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: agents, allAgents: [] },
      customSystemPrompt,
      appendSystemPrompt,
    },
    abortController: createAbortController(),
    readFileState,
    getAppState,
    setAppState,
    messages: forkContextMessages,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }

  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages,
  }
}
