import { DOMParser } from '@xmldom/xmldom'
import { SYSTEMONE_MAX_XML_BYTES } from './constants.js'

export type XmlQuestion =
  | {
      type: 'choice'
      instructions: string
      criteria: Record<string, string | null>
    }
  | {
      type: 'score'
      instructions: string
      criteria: string[]
    }
  | {
      type: 'noul'
      instructions: string
      criteria?: { true?: string; false?: string }
    }

export type XmlRequest = {
  state?: string
  state_path?: string
  context_id?: string
  questions: Record<string, XmlQuestion>
  files?: string[]
  images?: string[]
  temperature?: number
}

function elementChildren(node: Element): Element[] {
  const children: Element[] = []
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes.item(i)
    if (child !== null && child.nodeType === 1) {
      children.push(child as Element)
    }
  }
  return children
}

function ownText(node: Element): string {
  let text = ''
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes.item(i)
    if (child !== null && (child.nodeType === 3 || child.nodeType === 4)) {
      text += child.nodeValue ?? ''
    }
  }
  return text
}

function attr(element: Element, name: string): string | undefined {
  if (!element.hasAttribute(name)) {
    return undefined
  }
  const value = element.getAttribute(name)?.trim()
  return value ? value : undefined
}

function textOf(element: Element): string {
  return ownText(element).trim()
}

function sourceOf(element: Element): string {
  const path = attr(element, 'path') ?? attr(element, 'value')
  if (path !== undefined) {
    return path
  }
  const text = textOf(element)
  if (!text) {
    throw new Error(
      `<${element.nodeName}> needs a path attribute or data URL content`,
    )
  }
  return text
}

function numberText(text: string, label: string): number {
  const value = Number(text)
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a number`)
  }
  return value
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function assertSafeKey(kind: string, key: string): void {
  if (FORBIDDEN_KEYS.has(key)) {
    throw new Error(`${kind} "${key}" is not allowed`)
  }
}

function parseQuestion(
  element: Element,
  questions: Record<string, XmlQuestion>,
): void {
  const id = attr(element, 'id')
  if (id === undefined) {
    throw new Error('<question> needs an id attribute')
  }
  assertSafeKey('question id', id)
  if (Object.hasOwn(questions, id)) {
    throw new Error(`duplicate question id "${id}"`)
  }
  const type = attr(element, 'type')
  if (type === undefined) {
    throw new Error(`question "${id}" needs a type attribute`)
  }
  const instructions = attr(element, 'instructions') ?? textOf(element)
  if (!instructions) {
    throw new Error(
      `question "${id}" needs text content or an instructions attribute`,
    )
  }

  if (type === 'choice') {
    const criteria: Record<string, string | null> = Object.create(null)
    for (const option of elementChildren(element)) {
      if (option.nodeName !== 'option') {
        throw new Error(
          `choice question "${id}" only accepts <option> children, got <${option.nodeName}>`,
        )
      }
      const key = attr(option, 'key') ?? attr(option, 'value')
      if (key === undefined) {
        throw new Error(`choice question "${id}" has an <option> without key`)
      }
      assertSafeKey('option key', key)
      if (Object.hasOwn(criteria, key)) {
        throw new Error(`choice question "${id}" has duplicate option "${key}"`)
      }
      const description = attr(option, 'description') ?? textOf(option)
      criteria[key] = description ? description : null
    }
    if (Object.keys(criteria).length === 0) {
      throw new Error(`choice question "${id}" needs at least one <option>`)
    }
    questions[id] = { type, instructions, criteria }
    return
  }

  if (type === 'score') {
    const criteria: string[] = []
    for (const level of elementChildren(element)) {
      if (level.nodeName !== 'level') {
        throw new Error(
          `score question "${id}" only accepts <level> children, got <${level.nodeName}>`,
        )
      }
      const text = textOf(level)
      if (!text) {
        throw new Error(`score question "${id}" has an empty <level>`)
      }
      criteria.push(text)
    }
    if (criteria.length === 0) {
      throw new Error(`score question "${id}" needs at least two <level>`)
    }
    questions[id] = { type, instructions, criteria }
    return
  }

  if (type === 'noul') {
    const criteria: { true?: string; false?: string } = {}
    const trueText = attr(element, 'true')
    const falseText = attr(element, 'false')
    if (trueText !== undefined) {
      criteria.true = trueText
    }
    if (falseText !== undefined) {
      criteria.false = falseText
    }
    for (const child of elementChildren(element)) {
      if (child.nodeName === 'true' || child.nodeName === 'false') {
        const text = textOf(child)
        if (text) {
          criteria[child.nodeName] = text
        }
      } else {
        throw new Error(
          `noul question "${id}" only accepts <true> and <false> children, got <${child.nodeName}>`,
        )
      }
    }
    questions[id] = {
      type,
      instructions,
      ...(Object.keys(criteria).length > 0 ? { criteria } : {}),
    }
    return
  }

  throw new Error(`question "${id}" has unknown type "${type}"`)
}

/**
 * Parse the compact XML form of a Systemone request. The result is shaped
 * like the structured tool input and is re-validated by the tool schema before
 * anything is read or sent.
 */
export function parseSystemoneXml(xml: string): XmlRequest {
  if (Buffer.byteLength(xml, 'utf8') > SYSTEMONE_MAX_XML_BYTES) {
    throw new Error(
      `request_xml exceeds the ${SYSTEMONE_MAX_XML_BYTES}-byte limit`,
    )
  }
  // The tool has no reason to accept a DTD; refusing them also rules out
  // external entities and entity-expansion attacks.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error('request_xml must not contain DTD or entity declarations')
  }

  const issues: string[] = []
  const doc = new DOMParser({
    errorHandler: (level, message) => {
      if (level !== 'warning') {
        issues.push(String(message))
      }
    },
  }).parseFromString(xml, 'text/xml')
  if (issues.length > 0) {
    throw new Error(issues.join('; '))
  }
  const root = doc.documentElement
  if (root === null || root === undefined || root.nodeName !== 'systemone') {
    throw new Error('request_xml root element must be <systemone>')
  }

  const request: XmlRequest = {
    questions: Object.create(null) as Record<string, XmlQuestion>,
  }
  const files: string[] = []
  const images: string[] = []

  const rootStatePath = attr(root, 'state_path')
  if (rootStatePath !== undefined) {
    request.state_path = rootStatePath
  }
  const rootContextId = attr(root, 'context_id')
  if (rootContextId !== undefined) {
    request.context_id = rootContextId
  }
  const rootTemperature = attr(root, 'temperature')
  if (rootTemperature !== undefined) {
    request.temperature = numberText(rootTemperature, 'temperature')
  }

  const setState = (element: Element): void => {
    if (request.state !== undefined || request.state_path !== undefined) {
      throw new Error('request_xml may contain only one state or state_path')
    }
    const path = attr(element, 'path')
    if (path !== undefined) {
      request.state_path = path
      return
    }
    if (elementChildren(element).length > 0) {
      throw new Error(
        '<state> must contain plain text; use state_path or escape markup',
      )
    }
    request.state = textOf(element)
  }

  for (const child of elementChildren(root)) {
    switch (child.nodeName) {
      case 'state':
        setState(child)
        break
      case 'state_path': {
        if (request.state !== undefined || request.state_path !== undefined) {
          throw new Error(
            'request_xml may contain only one state or state_path',
          )
        }
        const text = textOf(child)
        if (!text) {
          throw new Error('<state_path> must not be empty')
        }
        request.state_path = text
        break
      }
      case 'context_id': {
        if (request.context_id !== undefined) {
          throw new Error('duplicate context_id')
        }
        const text = textOf(child)
        if (!text) {
          throw new Error('<context_id> must not be empty')
        }
        request.context_id = text
        break
      }
      case 'temperature': {
        if (request.temperature !== undefined) {
          throw new Error('duplicate temperature')
        }
        const text = textOf(child)
        if (!text) {
          throw new Error('<temperature> must not be empty')
        }
        request.temperature = numberText(text, 'temperature')
        break
      }
      case 'question':
        parseQuestion(child, request.questions)
        break
      case 'image':
        images.push(sourceOf(child))
        break
      case 'file':
        files.push(sourceOf(child))
        break
      case 'images':
      case 'files': {
        const target = child.nodeName === 'images' ? images : files
        const expected = child.nodeName === 'images' ? 'image' : 'file'
        for (const item of elementChildren(child)) {
          if (item.nodeName !== expected) {
            throw new Error(
              `<${child.nodeName}> only accepts <${expected}> children, got <${item.nodeName}>`,
            )
          }
          target.push(sourceOf(item))
        }
        break
      }
      default:
        throw new Error(`unknown element <${child.nodeName}> in <systemone>`)
    }
  }

  if (request.state === undefined && request.state_path === undefined) {
    const text = ownText(root).trim()
    if (text) {
      request.state = text
    }
  }
  if (files.length > 0) {
    request.files = files
  }
  if (images.length > 0) {
    request.images = images
  }
  if (Object.keys(request.questions).length === 0) {
    throw new Error('request_xml needs at least one <question>')
  }
  return request
}
