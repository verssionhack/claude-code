import { describe, expect, test } from 'bun:test'
import { parseSystemoneXml } from '../xml.js'

describe('parseSystemoneXml', () => {
  test('parses state_path, context_id, temperature, and all question types', () => {
    const request = parseSystemoneXml(`
      <systemone state_path="/tmp/doc.txt" context_id="ctx" temperature="0.5">
        <question id="angry" type="noul" instructions="Is it angry?">
          <true>The customer is angry</true>
          <false>The customer is calm</false>
        </question>
        <question id="request" type="choice">
          What does the customer want?
          <option key="refund">a refund</option>
          <option key="shipping" description="shipping status"/>
          <option key="other"/>
        </question>
        <question id="urgency" type="score">
          How urgent is it?
          <level>low</level>
          <level>high</level>
        </question>
        <image path="/tmp/a.png"/>
        <file>/tmp/b.png</file>
        <images><image>data:image/png;base64,AAAA</image></images>
      </systemone>
    `)

    expect(request.state_path).toBe('/tmp/doc.txt')
    expect(request.context_id).toBe('ctx')
    expect(request.temperature).toBe(0.5)
    expect(request.state).toBeUndefined()
    expect(request.questions.angry).toEqual({
      type: 'noul',
      instructions: 'Is it angry?',
      criteria: {
        true: 'The customer is angry',
        false: 'The customer is calm',
      },
    })
    expect(request.questions.request).toEqual({
      type: 'choice',
      instructions: 'What does the customer want?',
      criteria: {
        refund: 'a refund',
        shipping: 'shipping status',
        other: null,
      },
    })
    expect(request.questions.urgency).toEqual({
      type: 'score',
      instructions: 'How urgent is it?',
      criteria: ['low', 'high'],
    })
    expect(request.images).toEqual(['/tmp/a.png', 'data:image/png;base64,AAAA'])
    expect(request.files).toEqual(['/tmp/b.png'])
  })

  test('accepts inline state as an element, root text, or state_path element', () => {
    expect(
      parseSystemoneXml(
        '<systemone><state>inline &amp; text</state><question id="q" type="noul">x</question></systemone>',
      ).state,
    ).toBe('inline & text')

    expect(
      parseSystemoneXml(
        '<systemone>root text<question id="q" type="noul">x</question></systemone>',
      ).state,
    ).toBe('root text')

    expect(
      parseSystemoneXml(
        '<systemone><state path="/tmp/a.txt"/><question id="q" type="noul">x</question></systemone>',
      ).state_path,
    ).toBe('/tmp/a.txt')

    expect(
      parseSystemoneXml(
        '<systemone><state_path>/tmp/b.txt</state_path><context_id>ctx</context_id><question id="q" type="noul">x</question></systemone>',
      ),
    ).toMatchObject({ state_path: '/tmp/b.txt', context_id: 'ctx' })
  })

  test('rejects nested state markup and duplicate fields', () => {
    expect(() =>
      parseSystemoneXml(
        '<systemone><state>foo <b>bar</b> baz</state><question id="q" type="noul">x</question></systemone>',
      ),
    ).toThrow('plain text')
    expect(() =>
      parseSystemoneXml(
        '<systemone context_id="a"><context_id>b</context_id><question id="q" type="noul">x</question></systemone>',
      ),
    ).toThrow('duplicate context_id')
    expect(() =>
      parseSystemoneXml(
        '<systemone temperature="1"><temperature>2</temperature><question id="q" type="noul">x</question></systemone>',
      ),
    ).toThrow('duplicate temperature')
  })

  test('rejects DTD and entity declarations', () => {
    expect(() =>
      parseSystemoneXml(
        '<!DOCTYPE systemone [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><systemone><state>&xxe;</state><question id="q" type="noul">x</question></systemone>',
      ),
    ).toThrow('must not contain DTD or entity declarations')
    expect(() =>
      parseSystemoneXml(
        '<!DOCTYPE systemone><systemone><question id="q" type="noul">x</question></systemone>',
      ),
    ).toThrow('must not contain DTD or entity declarations')
  })

  test('rejects malformed XML and unknown structure', () => {
    expect(() => parseSystemoneXml('<systemone><question>')).toThrow()
    expect(() =>
      parseSystemoneXml(
        '<other><question id="q" type="noul">x</question></other>',
      ),
    ).toThrow('root element must be <systemone>')
    expect(() => parseSystemoneXml('<systemone><bogus/></systemone>')).toThrow(
      'unknown element',
    )
    expect(() => parseSystemoneXml('<systemone></systemone>')).toThrow(
      'at least one <question>',
    )
  })

  test('rejects invalid questions', () => {
    expect(() =>
      parseSystemoneXml(
        '<systemone><question type="noul">x</question></systemone>',
      ),
    ).toThrow('id attribute')
    expect(() =>
      parseSystemoneXml('<systemone><question id="q">x</question></systemone>'),
    ).toThrow('type attribute')
    expect(() =>
      parseSystemoneXml(
        '<systemone><question id="q" type="other">x</question></systemone>',
      ),
    ).toThrow('unknown type')
    expect(() =>
      parseSystemoneXml(
        '<systemone><question id="q" type="choice">x</question></systemone>',
      ),
    ).toThrow('at least one <option>')
    expect(() =>
      parseSystemoneXml(
        '<systemone><question id="q" type="score">x</question></systemone>',
      ),
    ).toThrow('at least two <level>')
    expect(() =>
      parseSystemoneXml(
        '<systemone><question id="q" type="noul">a</question><question id="q" type="noul">b</question></systemone>',
      ),
    ).toThrow('duplicate question id')
    expect(() =>
      parseSystemoneXml(
        '<systemone><question id="q" type="choice">x<level>nope</level></question></systemone>',
      ),
    ).toThrow('only accepts <option>')
    expect(() =>
      parseSystemoneXml(
        '<systemone><question id="__proto__" type="noul">x</question></systemone>',
      ),
    ).toThrow('not allowed')
    expect(() =>
      parseSystemoneXml(
        '<systemone><question id="q" type="choice">x<option key="__proto__">y</option></question></systemone>',
      ),
    ).toThrow('not allowed')
  })
})
