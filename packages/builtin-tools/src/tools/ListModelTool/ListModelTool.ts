import { z } from 'zod/v4'
import { buildTool, type ToolResultBlockParam } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { MODEL_ALIASES } from 'src/utils/model/aliases.js'
import { getServerModels } from 'src/utils/model/modelCapabilities.js'

export const LIST_MODEL_TOOL_NAME = 'ListModel'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>
type ListModelInput = z.infer<InputSchema>

type ServerModelInfo = {
  id: string
  context?: number
}
type ListModelOutput = {
  aliases: string[]
  serverModels: ServerModelInfo[]
}

export const ListModelTool = buildTool({
  name: LIST_MODEL_TOOL_NAME,
  searchHint: 'list available models aliases self-hosted server models',
  maxResultSizeChars: 20_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return 'List the model identifiers that can be passed to the Agent and WebFetch model parameters'
  },

  async prompt() {
    return `List the model identifiers available for use in the \`model\` parameter of the Agent and WebFetch tools.

Returns two groups:
- \`aliases\` — stable family aliases and the special \`inherit\` value, always available.
- \`serverModels\` — model ids reported by the current backend via /v1/models (self-hosted backends such as llama.cpp only). Each may carry a \`context\` token count.

Pass any returned identifier — an alias or a full server model id — directly as \`model\` when spawning an Agent or fetching a page. \`serverModels\` is empty for the official Anthropic API.`
  },

  isConcurrencySafe() {
    return true
  },

  isReadOnly() {
    return true
  },

  userFacingName() {
    return LIST_MODEL_TOOL_NAME
  },

  renderToolUseMessage() {
    return 'ListModel'
  },

  mapToolResultToToolResultBlockParam(
    content: ListModelOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    const aliasLines = content.aliases.map(a => `  - ${a}`)
    const serverLines =
      content.serverModels.length > 0
        ? content.serverModels.map(
            m =>
              `  - ${m.id}${m.context ? ` (context: ${m.context.toLocaleString()} tokens)` : ''}`,
          )
        : []
    const body = [
      `Aliases (always available):`,
      ...aliasLines,
      '',
      `Server models (${content.serverModels.length}):`,
      ...(serverLines.length > 0
        ? serverLines
        : ['  (none — backend did not report models or is the official API)']),
    ].join('\n')
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: body,
    }
  },

  async call(_input: ListModelInput): Promise<{ data: ListModelOutput }> {
    const aliases = [...MODEL_ALIASES, 'inherit']

    const serverModels: ServerModelInfo[] = getServerModels().map(m => ({
      id: m.id,
      context: m.maxInputTokens,
    }))

    return { data: { aliases, serverModels } }
  },
})
