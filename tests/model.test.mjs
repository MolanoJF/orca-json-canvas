import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { serialize } from '../editor/model.js'

test('demo serialization preserves board content and is stable after normalization', async () => {
  const board = JSON.parse(await readFile(new URL('../dev/demo/demo.canvas', import.meta.url), 'utf8'))
  const text = serialize(board)
  const normalized = JSON.parse(text)
  assert.equal(normalized.nodes.length, board.nodes.length)
  assert.equal(normalized.edges.length, board.edges.length)
  for (const node of board.nodes) assert.deepEqual(normalized.nodes.find((n) => n.id === node.id), node)
  assert.equal(serialize(normalized), text)
  assert.equal(normalized.edges.find((e) => e.id === 'e1').label, 'informs')
})
