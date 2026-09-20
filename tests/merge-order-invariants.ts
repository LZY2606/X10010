import { parse, parseDocument } from 'yaml'

// These tests pin down ordering invariants that are determined by the code
// structure rather than by comments:
//
// 1. The merge key `<<` is expanded at the position of its pair by
//    `addPairToJSMap`, and its expansion only fills in keys that do not yet
//    exist on the target map (merge never overrides a key already written by
//    an earlier normal pair, and a later normal pair still overrides it).
// 2. The lexical shape of a quoted scalar (single quotes) forces the string
//    tag before schema `test` matching happens, so "'42'" is never a number.
//
// See ANALYSIS.md for the exact one-line mutations that turn these red.

const opts = { schema: 'yaml-1.1' as const }

describe('merge key (<<) write ordering', () => {
  test('merge after a normal key does not overwrite it', () => {
    const doc = parse(
      'base: &b { a: 1 }\n' +
        'x:\n' +
        '  a: 99\n' +
        '  <<: *b\n',
      opts
    )
    expect(doc.x).toEqual({ a: 99 })
  })

  test('merge before a normal key is overridden by it', () => {
    const doc = parse(
      'base: &b { a: 1 }\n' +
        'x:\n' +
        '  <<: *b\n' +
        '  a: 99\n',
      opts
    )
    expect(doc.x.a).toBe(99)
  })

  test('merged keys are inserted at the pair position', () => {
    const doc = parse(
      'base: &b { m: 1, k: 2 }\n' +
        'x:\n' +
        '  a: 99\n' +
        '  <<: *b\n' +
        '  c: 3\n',
      opts
    )
    // The merged entries land between the earlier `a` and the later `c`.
    expect(Object.keys(doc.x)).toEqual(['a', 'm', 'k', 'c'])
    expect(doc.x).toEqual({ a: 99, m: 1, k: 2, c: 3 })
  })

  test('inline map merge follows the same no-overwrite ordering', () => {
    const doc = parse(
      'x:\n' +
        '  a: 99\n' +
        '  <<: { m: 1 }\n' +
        '  c: 3\n',
      opts
    )
    expect(Object.keys(doc.x)).toEqual(['a', 'm', 'c'])
    expect(doc.x).toEqual({ a: 99, m: 1, c: 3 })
  })

  test('Map output also keeps earlier normal keys', () => {
    const root = parse(
      'base: &b { a: 1 }\n' +
        'x:\n' +
        '  a: 99\n' +
        '  <<: *b\n',
      { ...opts, mapAsMap: true }
    ) as unknown as Map<string, Map<string, number>>
    expect(root.get('x')!.get('a')).toBe(99)
  })

  test('earlier maps in a merge sequence take precedence over later ones', () => {
    const doc = parse('x:\n  <<: [{ a: 1 }, { a: 2 }]\n', opts)
    expect(doc.x.a).toBe(1)
  })
})

describe('scalar resolution ordering', () => {
  test('single-quoted 42 resolves as a string before schema test matching', () => {
    const doc = parseDocument("'42'")
    expect(doc.value.type).toBe('QUOTE_SINGLE')
    expect(doc.toJS()).toBe('42')
    expect(typeof doc.toJS()).toBe('string')
  })

  test('plain 42 still resolves through the int tag', () => {
    expect(parse('42')).toBe(42)
  })
})
