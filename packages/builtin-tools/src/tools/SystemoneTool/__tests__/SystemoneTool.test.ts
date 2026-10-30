import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionDecision } from 'src/types/permissions.js'
import type { ToolUseContext } from 'src/Tool.js'
import { AbortError } from 'src/utils/errors.js'
import { zodToJsonSchema } from 'src/utils/zodToJsonSchema.js'
import { setupAxiosMock } from '../../../../../../tests/mocks/axios'

const axiosHandle = setupAxiosMock()
const postMock = mock(async (..._args: unknown[]) => makeResponse(200, {}))
axiosHandle.stubs.post = postMock

const originalEnv = {
  base: process.env.SYSTEMONE_BASE_URL,
  key: process.env.SYSTEMONE_API_KEY,
  timeout: process.env.SYSTEMONE_TIMEOUT_MS,
}

function makeResponse(status: number, data: unknown) {
  return {
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    data,
    headers: {},
    config: {},
  }
}

function testContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
  } as unknown as ToolUseContext
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

async function loadTool() {
  return (await import('../SystemoneTool.js')).SystemoneTool
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
])
let imageDir: string
let pngPath: string
let statePath: string
let textPath: string

beforeAll(async () => {
  axiosHandle.useStubs = true
  imageDir = await mkdtemp(join(tmpdir(), 'systemone-tool-'))
  pngPath = join(imageDir, 'red.png')
  statePath = join(imageDir, 'context.txt')
  textPath = join(imageDir, 'note.txt')
  await writeFile(pngPath, PNG_BYTES)
  await writeFile(statePath, 'shared context')
  await writeFile(textPath, 'not an image')
})

afterAll(async () => {
  axiosHandle.useStubs = false
  await rm(imageDir, { recursive: true, force: true })
})

beforeEach(() => {
  postMock.mockClear()
  process.env.SYSTEMONE_BASE_URL = 'http://systemone.test'
  delete process.env.SYSTEMONE_API_KEY
  delete process.env.SYSTEMONE_TIMEOUT_MS
})

afterEach(() => {
  restoreEnv('SYSTEMONE_BASE_URL', originalEnv.base)
  restoreEnv('SYSTEMONE_API_KEY', originalEnv.key)
  restoreEnv('SYSTEMONE_TIMEOUT_MS', originalEnv.timeout)
})

describe('SystemoneTool', () => {
  test('posts the typed request and returns the server body + context id', async () => {
    postMock.mockImplementation(async (...args: unknown[]) => {
      const [url, body, config] = args as [
        string,
        Record<string, unknown>,
        {
          headers: Record<string, string>
          signal: AbortSignal
          timeout: number
        },
      ]
      expect(url).toBe('http://systemone.test/v1/systemone')
      expect(body.state).toBe('the context')
      expect(body.questions).toEqual({
        red: { type: 'noul', instructions: 'Is it red?' },
      })
      expect(config.headers['Content-Type']).toBe('application/json')
      expect(config.signal).toBeInstanceOf(AbortSignal)
      expect(config.timeout).toBeGreaterThan(0)
      return makeResponse(200, {
        model: 'm',
        answers: { red: { type: 'noul', noul: 0.8 } },
        usage: { input_tokens: 5, output_tokens: 0 },
      })
    })

    const tool = await loadTool()
    const output = await tool.call(
      {
        state: 'the context',
        questions: { red: { type: 'noul', instructions: 'Is it red?' } },
      },
      testContext(),
    )

    expect(output.data.status).toBe(200)
    expect(output.data.body).toEqual({
      model: 'm',
      answers: { red: { type: 'noul', noul: 0.8 } },
      usage: { input_tokens: 5, output_tokens: 0 },
    })
    expect(output.data.context_id).toMatch(/^systemone-[0-9a-f]{12}$/)

    const block = tool.mapToolResultToToolResultBlockParam(output.data, 'tu-1')
    expect(block.is_error).toBeUndefined()
    expect(block.content).toContain('"noul":0.8')
    expect(block.content).toContain('context_id:')
  })

  test('reuses a cached state for follow-ups and never needs it again', async () => {
    postMock.mockImplementation(async (...args: unknown[]) => {
      const [, body] = args as [string, Record<string, unknown>]
      expect(body.state).toEqual({ note: 'same bytes', nested: { a: 1 } })
      return makeResponse(200, { answers: {}, usage: {} })
    })

    const tool = await loadTool()
    const first = await tool.call(
      {
        context_id: 'ctx-reuse',
        state: { note: 'same bytes', nested: { a: 1 } },
        questions: { q: { type: 'noul', instructions: 'x' } },
      },
      testContext(),
    )
    expect(first.data.status).toBe(200)
    expect(first.data.context_id).toBe('ctx-reuse')
    expect(postMock).toHaveBeenCalledTimes(1)

    const second = await tool.call(
      {
        context_id: 'ctx-reuse',
        questions: { q2: { type: 'noul', instructions: 'y' } },
      },
      testContext(),
    )
    expect(second.data.status).toBe(200)
    expect(postMock).toHaveBeenCalledTimes(2)
  })

  test('a context_id follow-up resends the images cached with the state', async () => {
    const bodies: Array<Record<string, unknown>> = []
    postMock.mockImplementation(async (...args: unknown[]) => {
      const [, body] = args as [string, Record<string, unknown>]
      bodies.push(body)
      return makeResponse(200, { answers: {} })
    })

    const tool = await loadTool()
    const first = await tool.call(
      {
        context_id: 'ctx-images',
        state: 'a picture',
        files: ['data:image/png;base64,AAAA'],
        images: ['data:image/png;base64,BBBB'],
        questions: { q: { type: 'noul', instructions: 'x' } },
      },
      testContext(),
    )
    expect(first.data.context_id).toBe('ctx-images')

    const second = await tool.call(
      {
        context_id: 'ctx-images',
        questions: { q2: { type: 'noul', instructions: 'y' } },
      },
      testContext(),
    )
    expect(second.data.context_id).toBe('ctx-images')
    expect(second.data.notice).toBeUndefined()

    expect(bodies).toHaveLength(2)
    expect(bodies[1]?.state).toBe('a picture')
    expect(bodies[1]?.files).toEqual(['data:image/png;base64,AAAA'])
    expect(bodies[1]?.images).toEqual(['data:image/png;base64,BBBB'])
  })

  test('the automatic context id covers images', async () => {
    postMock.mockImplementation(async () => makeResponse(200, { answers: {} }))

    const tool = await loadTool()
    const question = {
      q: { type: 'noul' as const, instructions: 'x' },
    }
    const a = await tool.call(
      {
        state: 'same state',
        files: ['data:image/png;base64,AAAA'],
        questions: question,
      },
      testContext(),
    )
    const b = await tool.call(
      {
        state: 'same state',
        files: ['data:image/png;base64,BBBB'],
        questions: question,
      },
      testContext(),
    )
    const sameAgain = await tool.call(
      {
        state: 'same state',
        files: ['data:image/png;base64,AAAA'],
        questions: question,
      },
      testContext(),
    )

    expect(a.data.context_id).toMatch(/^systemone-[0-9a-f]{12}$/)
    expect(b.data.context_id).not.toBe(a.data.context_id)
    expect(sameAgain.data.context_id).toBe(a.data.context_id)
  })

  test('rejects an unknown context_id without calling the server', async () => {
    const tool = await loadTool()
    const output = await tool.call(
      {
        context_id: 'ctx-does-not-exist',
        questions: { q: { type: 'noul', instructions: 'x' } },
      },
      testContext(),
    )
    expect(output.data.status).toBe(400)
    expect(output.data.error).toContain('Unknown context_id')
    expect(postMock).not.toHaveBeenCalled()

    const block = tool.mapToolResultToToolResultBlockParam(output.data, 'tu-2')
    expect(block.is_error).toBe(true)
  })

  test('returns an error result with the base URL on network failure', async () => {
    postMock.mockImplementation(async () => {
      throw new Error('connect ECONNREFUSED')
    })

    const tool = await loadTool()
    const output = await tool.call(
      {
        state: 'ctx',
        questions: { q: { type: 'noul', instructions: 'x' } },
      },
      testContext(),
    )
    expect(output.data.status).toBe(0)
    expect(output.data.error).toContain('ECONNREFUSED')
    expect(output.data.error).toContain('http://systemone.test')
    expect(
      tool.mapToolResultToToolResultBlockParam(output.data, 'tu-3').is_error,
    ).toBe(true)
  })

  test('surfaces the server error message/code for a 4xx', async () => {
    postMock.mockImplementation(async () =>
      makeResponse(400, {
        error: { message: 'state is required', code: 'invalid_request_error' },
      }),
    )

    const tool = await loadTool()
    const output = await tool.call(
      {
        state: 'ctx',
        questions: { q: { type: 'noul', instructions: 'x' } },
      },
      testContext(),
    )
    expect(output.data.status).toBe(400)
    expect(output.data.error).toBe('state is required (invalid_request_error)')
    const block = tool.mapToolResultToToolResultBlockParam(output.data, 'tu-4')
    expect(block.is_error).toBe(true)
    expect(block.content).toContain('HTTP 400')
  })

  test('forwards the API key, images, and temperature', async () => {
    process.env.SYSTEMONE_API_KEY = 'secret'
    postMock.mockImplementation(async (...args: unknown[]) => {
      const [, body, config] = args as [
        string,
        Record<string, unknown>,
        { headers: Record<string, string> },
      ]
      expect(config.headers.Authorization).toBe('Bearer secret')
      expect(body.files).toEqual(['data:image/png;base64,AAAA'])
      expect(body.images).toEqual(['data:image/png;base64,BBBB'])
      expect(body.temperature).toBe(0.25)
      return makeResponse(200, { answers: {} })
    })

    const tool = await loadTool()
    const output = await tool.call(
      {
        state: 'ctx',
        questions: {
          q: { type: 'score', instructions: 'x', criteria: ['a', 'b'] },
        },
        files: ['data:image/png;base64,AAAA'],
        images: ['data:image/png;base64,BBBB'],
        temperature: 0.25,
      },
      testContext(),
    )
    expect(output.data.status).toBe(200)
  })

  test('reads image paths itself and resends encoded images on follow-ups', async () => {
    const bodies: Array<Record<string, unknown>> = []
    postMock.mockImplementation(async (...args: unknown[]) => {
      const [, body] = args as [string, Record<string, unknown>]
      bodies.push(body)
      return makeResponse(200, { answers: {} })
    })

    const tool = await loadTool()
    const expected = `data:image/png;base64,${PNG_BYTES.toString('base64')}`
    const first = await tool.call(
      {
        context_id: 'ctx-image-path',
        state: 'a red square',
        files: [pngPath],
        questions: { q: { type: 'noul', instructions: 'x' } },
      },
      testContext(),
    )
    expect(first.data.status).toBe(200)
    expect(bodies[0]?.files).toEqual([expected])

    const second = await tool.call(
      {
        context_id: 'ctx-image-path',
        questions: { q2: { type: 'noul', instructions: 'y' } },
      },
      testContext(),
    )
    expect(second.data.status).toBe(200)
    expect(bodies[1]?.files).toEqual([expected])
  })

  test('accepts image-only contexts and sends an empty state', async () => {
    const bodies: Array<Record<string, unknown>> = []
    postMock.mockImplementation(async (...args: unknown[]) => {
      const [, body] = args as [string, Record<string, unknown>]
      bodies.push(body)
      return makeResponse(200, { answers: {} })
    })

    const tool = await loadTool()
    const expected = `data:image/png;base64,${PNG_BYTES.toString('base64')}`
    const first = await tool.call(
      {
        files: [pngPath],
        questions: { q: { type: 'noul', instructions: 'x' } },
      },
      testContext(),
    )
    expect(first.data.status).toBe(200)
    expect(first.data.context_id).toMatch(/^systemone-[0-9a-f]{12}$/)
    expect(bodies[0]?.state).toBe('')
    expect(bodies[0]?.files).toEqual([expected])

    const follow = await tool.call(
      {
        context_id: first.data.context_id,
        questions: { q2: { type: 'noul', instructions: 'y' } },
      },
      testContext(),
    )
    expect(follow.data.status).toBe(200)
    expect(bodies[1]?.state).toBe('')
    expect(bodies[1]?.files).toEqual([expected])
  })

  test('a path and its equivalent data URL share one automatic context id', async () => {
    postMock.mockImplementation(async () => makeResponse(200, { answers: {} }))

    const tool = await loadTool()
    const questions = {
      q: { type: 'noul' as const, instructions: 'x' },
    }
    const fromPath = await tool.call(
      { state: 'same', files: [pngPath], questions },
      testContext(),
    )
    const fromDataUrl = await tool.call(
      {
        state: 'same',
        files: [`data:image/png;base64,${PNG_BYTES.toString('base64')}`],
        questions,
      },
      testContext(),
    )
    expect(fromPath.data.context_id).toMatch(/^systemone-[0-9a-f]{12}$/)
    expect(fromDataUrl.data.context_id).toBe(fromPath.data.context_id)
  })

  test('rejects unreadable or unsupported image paths without calling the server', async () => {
    const tool = await loadTool()
    const missing = await tool.call(
      {
        state: 'ctx',
        files: [join(imageDir, 'missing.png')],
        questions: { q: { type: 'noul', instructions: 'x' } },
      },
      testContext(),
    )
    expect(missing.data.status).toBe(400)
    expect(missing.data.error).toContain('Cannot read image file')

    const unsupported = await tool.call(
      {
        state: 'ctx',
        files: [textPath],
        questions: { q: { type: 'noul', instructions: 'x' } },
      },
      testContext(),
    )
    expect(unsupported.data.status).toBe(400)
    expect(unsupported.data.error).toContain('Unsupported image format')
    expect(postMock).not.toHaveBeenCalled()
  })

  test('reads state_path itself and resends the cached text after the file is gone', async () => {
    const transient = join(imageDir, 'transient-context.txt')
    await writeFile(transient, 'file-only context')
    const bodies: Array<Record<string, unknown>> = []
    postMock.mockImplementation(async (...args: unknown[]) => {
      const [, body] = args as [string, Record<string, unknown>]
      bodies.push(body)
      return makeResponse(200, { answers: {} })
    })

    const tool = await loadTool()
    const first = await tool.call(
      {
        context_id: 'ctx-state-path',
        state_path: transient,
        questions: { q: { type: 'noul', instructions: 'x' } },
      },
      testContext(),
    )
    expect(first.data.status).toBe(200)
    expect(first.data.context_id).toBe('ctx-state-path')
    expect(bodies[0]?.state).toBe('file-only context')

    await rm(transient, { force: true })
    const second = await tool.call(
      {
        context_id: 'ctx-state-path',
        questions: { q2: { type: 'noul', instructions: 'y' } },
      },
      testContext(),
    )
    expect(second.data.status).toBe(200)
    expect(bodies[1]?.state).toBe('file-only context')
  })

  test('a state_path and its inline text share one automatic context id', async () => {
    postMock.mockImplementation(async () => makeResponse(200, { answers: {} }))

    const tool = await loadTool()
    const questions = {
      q: { type: 'noul' as const, instructions: 'x' },
    }
    const fromPath = await tool.call(
      { state_path: statePath, questions },
      testContext(),
    )
    const fromState = await tool.call(
      { state: 'shared context', questions },
      testContext(),
    )
    expect(fromPath.data.context_id).toMatch(/^systemone-[0-9a-f]{12}$/)
    expect(fromState.data.context_id).toBe(fromPath.data.context_id)
  })

  test('rejects state_path with state or when the file is missing', async () => {
    const tool = await loadTool()
    const both = await tool.call(
      {
        state: 'inline',
        state_path: statePath,
        questions: { q: { type: 'noul', instructions: 'x' } },
      },
      testContext(),
    )
    expect(both.data.status).toBe(400)
    expect(both.data.error).toContain('either state or state_path')

    const missing = await tool.call(
      {
        state_path: join(imageDir, 'missing.txt'),
        questions: { q: { type: 'noul', instructions: 'x' } },
      },
      testContext(),
    )
    expect(missing.data.status).toBe(400)
    expect(missing.data.error).toContain('Cannot read state file')
    expect(postMock).not.toHaveBeenCalled()
  })

  test('accepts an XML request, parses it, and reuses it by context_id', async () => {
    const bodies: Array<Record<string, unknown>> = []
    postMock.mockImplementation(async (...args: unknown[]) => {
      const [, body] = args as [string, Record<string, unknown>]
      bodies.push(body)
      return makeResponse(200, { answers: {} })
    })

    const tool = await loadTool()
    const xml = `<systemone state_path="${statePath}" temperature="0.5">
      <question id="q" type="choice">Pick?
        <option key="a">A</option>
        <option key="b">B</option>
      </question>
      <question id="r" type="noul">Red?</question>
    </systemone>`
    const first = await tool.call({ request_xml: xml }, testContext())
    expect(first.data.status).toBe(200)
    expect(first.data.context_id).toMatch(/^systemone-[0-9a-f]{12}$/)
    expect(bodies[0]?.state).toBe('shared context')
    expect(bodies[0]?.temperature).toBe(0.5)
    expect(bodies[0]?.request_xml).toBeUndefined()
    expect(Object.keys(bodies[0]?.questions as object)).toEqual(['q', 'r'])

    const follow = await tool.call(
      {
        request_xml: `<systemone context_id="${first.data.context_id}">
          <question id="s" type="noul">Still red?</question>
        </systemone>`,
      },
      testContext(),
    )
    expect(follow.data.status).toBe(200)
    expect(bodies[1]?.state).toBe('shared context')
    expect(Object.keys(bodies[1]?.questions as object)).toEqual(['s'])
  })

  test('rejects mixed or invalid XML requests without calling the server', async () => {
    const tool = await loadTool()
    const xml = `<systemone state_path="${statePath}">
      <question id="q" type="noul">x</question>
    </systemone>`

    const mixed = await tool.call(
      { request_xml: xml, state: 'inline' },
      testContext(),
    )
    expect(mixed.data.status).toBe(400)
    expect(mixed.data.error).toContain('cannot be combined with state')

    const invalid = await tool.call(
      {
        request_xml:
          '<systemone><question id="q" type="score">x</question></systemone>',
      },
      testContext(),
    )
    expect(invalid.data.status).toBe(400)
    expect(invalid.data.error).toContain('Invalid request_xml')
    expect(invalid.data.error).toContain('at least two <level>')
    expect(postMock).not.toHaveBeenCalled()
  })

  test('a denied image path wins and every ask path is reported', async () => {
    const { combineImagePermissionDecisions } = await import(
      '../SystemoneTool.js'
    )
    const allow = { behavior: 'allow' } as unknown as PermissionDecision
    const askA = {
      behavior: 'ask',
      message: 'read /a?',
    } as unknown as PermissionDecision
    const askB = {
      behavior: 'ask',
      message: 'read /b?',
    } as unknown as PermissionDecision
    const deny = {
      behavior: 'deny',
      message: 'no',
      decisionReason: { type: 'other', reason: 'test' },
    } as unknown as PermissionDecision

    expect(combineImagePermissionDecisions([allow, allow])).toBeUndefined()
    expect(combineImagePermissionDecisions([allow, askA])).toBe(askA)
    expect(combineImagePermissionDecisions([allow, askA, deny])).toBe(deny)

    const combined = combineImagePermissionDecisions([askA, allow, askB])
    expect(combined?.behavior).toBe('ask')
    if (combined?.behavior === 'ask') {
      expect(combined.message).toContain('read /a?')
      expect(combined.message).toContain('read /b?')
    }
  })

  test('aborts before sending when the session is already aborted', async () => {
    const context = testContext()
    const controller = (
      context as unknown as { abortController: AbortController }
    ).abortController
    controller.abort()

    const tool = await loadTool()
    await expect(
      tool.call(
        {
          state: 'ctx',
          questions: { q: { type: 'noul', instructions: 'x' } },
        },
        context,
      ),
    ).rejects.toBeInstanceOf(AbortError)
    expect(postMock).not.toHaveBeenCalled()
  })

  test('input schema converts to a JSON schema for the model', async () => {
    const tool = await loadTool()
    const schema = zodToJsonSchema(tool.inputSchema) as {
      type?: string
      properties?: Record<string, unknown>
      required?: string[]
    }
    expect(schema.type).toBe('object')
    expect(schema.properties?.questions).toBeDefined()
    expect(schema.properties?.state).toBeDefined()
    expect(schema.properties?.state_path).toBeDefined()
    expect(schema.properties?.request_xml).toBeDefined()
    expect(schema.required ?? []).not.toContain('questions')
  })

  test('schema rejects missing state, oversized option sets, and too many images', async () => {
    const tool = await loadTool()
    const schema = tool.inputSchema

    expect(
      schema.safeParse({
        questions: { q: { type: 'noul', instructions: 'x' } },
      }).success,
    ).toBe(false)

    expect(
      schema.safeParse({
        files: ['/tmp/image.png'],
        questions: { q: { type: 'noul', instructions: 'x' } },
      }).success,
    ).toBe(true)

    expect(
      schema.safeParse({
        state_path: '/tmp/context.txt',
        questions: { q: { type: 'noul', instructions: 'x' } },
      }).success,
    ).toBe(true)

    expect(
      schema.safeParse({
        state: 'inline',
        state_path: '/tmp/context.txt',
        questions: { q: { type: 'noul', instructions: 'x' } },
      }).success,
    ).toBe(false)

    const xml =
      '<systemone><question id="q" type="noul">x</question></systemone>'
    expect(schema.safeParse({ request_xml: xml }).success).toBe(true)
    expect(
      schema.safeParse({ request_xml: xml, state: 'inline' }).success,
    ).toBe(false)

    const manyOptions = Object.fromEntries(
      Array.from({ length: 53 }, (_, i) => [`o${i}`, null]),
    )
    expect(
      schema.safeParse({
        state: 'ctx',
        questions: {
          q: { type: 'choice', instructions: 'x', criteria: manyOptions },
        },
      }).success,
    ).toBe(false)

    expect(
      schema.safeParse({
        state: 'ctx',
        questions: {
          q: { type: 'score', instructions: 'x', criteria: ['only one'] },
        },
      }).success,
    ).toBe(false)

    expect(
      schema.safeParse({
        state: 'ctx',
        files: Array.from({ length: 5 }, () => 'data:image/png;base64,AAAA'),
        images: Array.from({ length: 4 }, () => 'data:image/png;base64,BBBB'),
        questions: { q: { type: 'noul', instructions: 'x' } },
      }).success,
    ).toBe(false)

    expect(
      schema.safeParse({
        state: 'ctx',
        questions: { q: { type: 'noul', instructions: 'x' } },
      }).success,
    ).toBe(true)
  })
})
