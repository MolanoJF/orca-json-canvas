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

test('pasted images land in Sources beside the canvas, safely', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'json-canvas-paste-'))
  t.after(() => fs.rm(scratch, { recursive: true, force: true }))
  const root = path.join(scratch, 'vault')
  const outside = path.join(scratch, 'outside')
  await fs.mkdir(path.join(root, 'Boards', 'One'), { recursive: true })
  await fs.mkdir(path.join(root, 'Boards', 'Two'), { recursive: true })
  await fs.mkdir(outside)
  const board = (ids) => JSON.stringify({ nodes: ids.map((id) => ({ id, type: 'text', text: id, x: 0, y: 0, width: 1, height: 1 })), edges: [] })
  await fs.writeFile(path.join(root, 'Boards', 'One', 'a.canvas'), board(['n1', 'n2']))
  await fs.writeFile(path.join(root, 'Boards', 'Two', 'b.canvas'), board(['n1', 'n9']))
  const handlers = new Map()
  activate({
    log() {},
    host: { has: (n) => n === 'workspace.list', call: async () => ({ workspaces: [{ id: 't', name: 't', path: root }] }) },
    settings: { get: async () => '' },
    panels: { handle: (name, fn) => handlers.set(name, fn) }
  })
  const call = (name, input) => handlers.get(name)(input, {})
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)])
  const b64 = png.toString('base64')
  const half = Math.ceil(b64.length / 2)

  // locating the canvas folder
  assert.deepEqual(await call('canvas.locateCanvas', { root, nodeIds: ['n2'] }), { dir: 'Boards/One', via: 'ids' })
  assert.equal((await call('canvas.locateCanvas', { root, nodeIds: ['n1'] })).ambiguous, true)
  assert.equal((await call('canvas.locateCanvas', { root, nodeIds: ['n1', 'n9'] })).dir, 'Boards/Two')
  assert.equal((await call('canvas.locateCanvas', { root, nodeIds: [] })).dir, null)
  assert.deepEqual(await call('canvas.locateCanvas', { root, canvasPath: path.join(root, 'Boards', 'One', 'a.canvas'), nodeIds: [] }), { dir: 'Boards/One', via: 'path' })

  // chunked write creates Sources/ and never overwrites
  const base = { root, dir: 'Boards/One', name: 'Pasted image 1', mime: 'image/png' }
  assert.deepEqual(await call('canvas.writeImage', { ...base, token: 'a', part: 0, parts: 2, base64: b64.slice(0, half) }), { done: false })
  const first = await call('canvas.writeImage', { ...base, token: 'a', part: 1, parts: 2, base64: b64.slice(half) })
  assert.equal(first.path, 'Boards/One/Sources/Pasted image 1.png')
  assert.deepEqual(await fs.readFile(path.join(root, first.path)), png)
  const second = await call('canvas.writeImage', { ...base, token: 'b', base64: b64 })
  assert.equal(second.path, 'Boards/One/Sources/Pasted image 1 2.png')

  // refusals
  await assert.rejects(call('canvas.writeImage', { ...base, token: 'c', base64: Buffer.from('not an image at all').toString('base64') }), { code: 'not_permitted' })
  await assert.rejects(call('canvas.writeImage', { ...base, token: 'd', mime: 'image/svg+xml', base64: b64 }), { code: 'not_permitted' })
  await assert.rejects(call('canvas.writeImage', { ...base, token: 'e', dir: '../outside', base64: b64 }), { code: 'not_permitted' })
  await assert.rejects(call('canvas.writeImage', { ...base, token: 'f', root: outside, base64: b64 }), { code: 'not_permitted' })
  const sneaky = await call('canvas.writeImage', { ...base, token: 'g', name: '../../escape.png', base64: b64 })
  assert.equal(path.dirname(sneaky.path), 'Boards/One/Sources')

  // Sources must not be a link out of the vault
  await fs.symlink(outside, path.join(root, 'Boards', 'Two', 'Sources'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(call('canvas.writeImage', { ...base, dir: 'Boards/Two', token: 'h', base64: b64 }), { code: 'not_permitted' })
  assert.deepEqual(await fs.readdir(outside), [])
})
