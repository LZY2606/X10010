import { parse } from 'yaml'

// Invariant pinned: when a YAML 1.1 merge key `<<` has a sequence value, its
// mappings are merged in source order, with earlier mappings winning on key
// conflicts (yaml.org/type/merge.html: "Keys in mapping nodes earlier in the
// sequence override keys specified in later mapping nodes"). This precedence
// is decided solely by the forward iteration
// `for (const it of source) mergeValue(...)` in
// src/schema/yaml-1.1/merge.ts's addMergeToJSMap(); nothing in the merge
// plumbing or in resolveBlockMap re-sorts the pairs.
const opts = { version: '1.1' as const }

test('merge sequence: earlier sources override later ones', () => {
  const src = ['<<: [{ a: 1, b: 1 }, { b: 2, c: 2 }]', 'd: 9', ''].join('\n')
  expect(parse(src, opts)).toEqual({ a: 1, b: 1, c: 2, d: 9 })
})

test('merge sequence order holds with aliases as sources', () => {
  const src = [
    'first: &first { b: 1 }',
    'second: &second { b: 2, c: 2 }',
    'merged:',
    '  <<: [*first, *second]',
    ''
  ].join('\n')
  expect(parse(src, opts).merged).toEqual({ b: 1, c: 2 })
})

test('explicit keys written in the same map win over every merge source', () => {
  const src = ['<<: [{ a: 1 }, { a: 2 }]', 'a: 3', ''].join('\n')
  expect(parse(src, opts)).toEqual({ a: 3 })
})
