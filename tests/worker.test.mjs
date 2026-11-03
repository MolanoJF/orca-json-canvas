import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import activate from '../worker/main.js'

test('vault file access, chunked note saves and conflict protection', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'json-canvas-test-'))
  t.after(() => fs.rm(scratch, { recursive: true, force: true }))
  const root = path.join(scratch, 'vault')
  const outside = path.join(scratch, 'outside')
  await fs.mkdir(root)
  await fs.mkdir(outside)
  await fs.writeFile(path.join(root, 'Note.md'), '# Original\n')
  await fs.writeFile(path.join(outside, 'Private.md'), 'outside')
  await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const handlers = new Map()
  activate({
    log() {},
    host: {
      has: (name) => name === 'workspace.list',
      call: async () => ({ workspaces: [{ id: 'test', name: 'test', path: root }] })
    },
    settings: { get: async () => '' },
    panels: { handle: (name, fn) => handlers.set(name, fn) }
  })
  const call = (name, input) => handlers.get(name)(input, {})
  const located = await call('canvas.locate', { paths: ['Note.md'] })
  assert.equal(located.root, root)
  assert.equal(located.matched, 1)
  const read = await call('canvas.read', { root, path: 'Note.md' })
  assert.equal(Buffer.from(read.base64, 'base64').toString(), '# Original\n')
  assert.equal(read.next, null)
  for (const rel of ['../outside/Private.md', 'escape/Private.md']) {
    await assert.rejects(call('canvas.read', { root, path: rel }), { code: 'not_permitted' })
    await assert.rejects(call('canvas.writeText', { root, path: rel, token: rel, text: 'bad' }), { code: 'not_permitted' })
  }
  await assert.rejects(call('canvas.text', { root: outside, path: 'Private.md' }), { code: 'not_permitted' })
  const stat = await fs.stat(path.join(root, 'Note.md'))
  assert.deepEqual(await call('canvas.writeText', {
    root, path: 'Note.md', token: 'save', part: 0, parts: 2, text: '# New', baseMtime: stat.mtimeMs
  }), { done: false })
  const saved = await call('canvas.writeText', {
    root, path: 'Note.md', token: 'save', part: 1, parts: 2, text: '\n', baseMtime: stat.mtimeMs
  })
  assert.equal(saved.done, true)
  assert.equal(await fs.readFile(path.join(root, 'Note.md'), 'utf8'), '# New\n')
  await assert.rejects(call('canvas.writeText', {
    root, path: 'Note.md', token: 'conflict', text: 'overwrite', baseMtime: 0
  }), { code: 'conflict' })
  assert.equal(await fs.readFile(path.join(root, 'Note.md'), 'utf8'), '# New\n')
  assert.equal(await fs.readFile(path.join(outside, 'Private.md'), 'utf8'), 'outside')
})
