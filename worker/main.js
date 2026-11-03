// Worker for the JSON Canvas editor.
//
// The editor frame is sandboxed: it gets the .canvas text but no path, no file system and no
// network. This worker runs in Node on the Orca host and does the parts that need the disk:
//   - finds which vault (Orca workspace or configured folder) the canvas belongs to
//   - resolves file nodes and [[wikilinks]] the way Obsidian does
//   - streams images/media to the frame in chunks (plugin.request answers are capped at 1 MiB)
//   - opens notes and files in an Orca tab
// File reads and inline Markdown edits stay inside a known vault root.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import os from 'node:os'

const CHUNK_BYTES = 640 * 1024 // base64 grows by 4/3 -> ~853 KiB, under the 1 MiB answer cap
const TEXT_LIMIT = 700 * 1024
const ROOTS_TTL_MS = 30_000
const INDEX_TTL_MS = 60_000
const INDEX_MAX_FILES = 200_000
const IS_WIN = process.platform === 'win32'

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon', tif: 'image/tiff',
  tiff: 'image/tiff', heic: 'image/heic',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', '3gp': 'audio/3gpp',
  pdf: 'application/pdf'
}

function kindOf(ext) {
  const mime = MIME[ext] || ''
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'md') return 'markdown'
  if (ext === 'canvas') return 'canvas'
  if (ext === 'base') return 'base'
  return 'other'
}

const extOf = (p) => path.extname(p).slice(1).toLowerCase()
const norm = (p) => {
  const r = path.resolve(p)
  return IS_WIN ? r.toLowerCase() : r
}
const toPosix = (p) => p.split(path.sep).join('/')

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// ---------------------------------------------------------------------------------------------
// Orca CLI (fallback for hosts whose plugin API lacks workspace.list / editor.open)

function cliPath() {
  if (process.env.ORCA_CLI) return process.env.ORCA_CLI
  // The worker runs as Orca.exe in Node mode; the CLI ships beside it.
  const bin = path.join(path.dirname(process.execPath), 'resources', 'bin', IS_WIN ? 'orca.exe' : 'orca')
  return bin
}

// Orca starts workers with a minimal environment; the CLI needs the user's profile folders to
// find the running app.
function cliEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const home = os.homedir()
  if (IS_WIN) {
    env.USERPROFILE ??= home
    env.APPDATA ??= path.join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA ??= path.join(home, 'AppData', 'Local')
    env.SystemRoot ??= process.env.SYSTEMROOT ?? 'C:\\Windows'
  } else {
    env.HOME ??= home
  }
  return env
}

function runCli(args, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    execFile(cliPath(), args, { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, env: cliEnv() }, (error, stdout, stderr) => {
      if (error) {
        let detail = stderr || ''
        try {
          detail = JSON.parse(stdout)?.error?.message || detail
        } catch {}
        reject(fail('action_failed', `orca ${args[0]} ${args[1] ?? ''} failed: ${detail || error.message}`))
      }
      else resolve(stdout)
    })
  })
}

// ---------------------------------------------------------------------------------------------
// Vault roots

let rootsCache = { at: 0, roots: [] }

async function listWorkspaces(orca) {
  if (orca.host.has('workspace.list')) {
    try {
      const { workspaces } = await orca.host.call('workspace.list', {})
      return workspaces
        .filter((w) => !w.hostId || w.hostId === 'local')
        .map((w) => ({ id: w.id, name: w.name, path: w.path }))
    } catch (error) {
      orca.log(`workspace.list failed, falling back to the CLI: ${error.message}`)
    }
  }
  try {
    const parsed = JSON.parse(await runCli(['worktree', 'list', '--json']))
    return (parsed.result?.worktrees ?? [])
      .filter((w) => (w.hostId ?? 'local') === 'local' && !w.isArchived)
      .map((w) => ({ id: w.id, name: w.displayName, path: w.path }))
  } catch (error) {
    orca.log(`could not list workspaces: ${error.message}`)
    return []
  }
}

async function configuredFolders(orca) {
  let value = ''
  try {
    if (orca.settings?.get) value = await orca.settings.get('vaultFolders')
    else value = (await orca.host.call('settings.get', {}))?.values?.vaultFolders
  } catch {}
  return String(value ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
}

// The vault root is the nearest folder at or above a workspace that holds `.obsidian`; a
// workspace with no vault above it counts as its own root.
async function vaultRootFor(dir) {
  let current = path.resolve(dir)
  for (let i = 0; i < 12; i++) {
    if (await isDir(path.join(current, '.obsidian'))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.resolve(dir)
}

async function getRoots(orca, fresh = false) {
  if (!fresh && Date.now() - rootsCache.at < ROOTS_TTL_MS && rootsCache.roots.length) return rootsCache.roots
  const workspaces = await listWorkspaces(orca)
  const extra = (await configuredFolders(orca)).map((p) => ({ id: null, name: path.basename(p), path: p }))
  const roots = []
  const seen = new Set()
  for (const ws of [...workspaces, ...extra]) {
    if (!ws.path || !(await isDir(ws.path))) continue
    const root = await vaultRootFor(ws.path)
    const key = norm(root)
    const existing = roots.find((r) => r.key === key)
    if (existing) {
      existing.workspaces.push(ws)
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    roots.push({ key, root, name: ws.name, workspaces: [ws] })
  }
  rootsCache = { at: Date.now(), roots }
  return roots
}

async function requireRoot(orca, root) {
  if (typeof root !== 'string' || !root) throw fail('invalid_params', 'root is required')
  const key = norm(root)
  let roots = await getRoots(orca)
  let found = roots.find((r) => r.key === key)
  if (!found) {
    roots = await getRoots(orca, true)
    found = roots.find((r) => r.key === key)
  }
  if (!found) throw fail('not_permitted', 'that folder is not a known vault')
  return found
}

// Resolves a vault-relative path and refuses anything that escapes the vault.
async function insideRoot(root, rel) {
  if (typeof rel !== 'string' || !rel) throw fail('invalid_params', 'path is required')
  const abs = path.resolve(root.root, rel)
  const rootKey = root.key.endsWith(path.sep) ? root.key : root.key + path.sep
  if (norm(abs) !== root.key && !norm(abs).startsWith(rootKey)) throw fail('not_permitted', 'path is outside the vault')
  // Junctions and symbolic links must not bypass the vault boundary.
  const [realRoot, realAbs] = await Promise.all([fs.realpath(root.root), fs.realpath(abs)])
  const relative = path.relative(realRoot, realAbs)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw fail('not_permitted', 'path resolves outside the vault')
  return realAbs
}

// ---------------------------------------------------------------------------------------------
// File index for Obsidian's shortest-path link resolution

const indexes = new Map() // root key -> { at, files: string[] (posix rel), byName: Map }

async function getIndex(root) {
  const cached = indexes.get(root.key)
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached
  const files = []
  const walk = async (dir, relDir) => {
    if (files.length >= INDEX_MAX_FILES) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel)
      else if (entry.isFile()) files.push(rel)
      if (files.length >= INDEX_MAX_FILES) return
    }
  }
  await walk(root.root, '')
  const byName = new Map()
  const add = (k, rel) => {
    const list = byName.get(k)
    if (list) list.push(rel)
    else byName.set(k, [rel])
  }
  for (const rel of files) {
    const base = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase()
    add(base, rel)
    if (base.endsWith('.md')) add(base.slice(0, -3), rel)
  }
  const index = { at: Date.now(), files, byName }
  indexes.set(root.key, index)
  return index
}

async function describe(root, rel) {
  const abs = await insideRoot(root, rel)
  try {
    const stat = await fs.stat(abs)
    if (!stat.isFile()) return null
    const ext = extOf(abs)
    return { path: toPosix(path.relative(root.root, abs)), size: stat.size, ext, kind: kindOf(ext), mime: MIME[ext] || null, mtime: stat.mtimeMs }
  } catch {
    return null
  }
}

// Obsidian link resolution: exact vault path, then path + .md, then relative to the source
// note, then the shortest path among files with the same name.
async function resolveLink(root, target, from) {
  let linkpath = String(target ?? '').trim()
  if (!linkpath) return null
  try {
    linkpath = decodeURI(linkpath)
  } catch {}
  linkpath = linkpath.replace(/\\/g, '/').replace(/^\/+/, '')
  const tries = [linkpath]
  if (!/\.[a-z0-9]+$/i.test(linkpath)) tries.push(`${linkpath}.md`)
  if (from) {
    const dir = path.posix.dirname(String(from).replace(/\\/g, '/'))
    if (dir && dir !== '.') {
      tries.push(path.posix.join(dir, linkpath))
      if (!/\.[a-z0-9]+$/i.test(linkpath)) tries.push(path.posix.join(dir, `${linkpath}.md`))
    }
  }
  for (const t of tries) {
    try {
      const d = await describe(root, t)
      if (d) return d
    } catch {}
  }
  const index = await getIndex(root)
  const lower = linkpath.toLowerCase()
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  const candidates = (index.byName.get(base) ?? []).filter((rel) => {
    const r = rel.toLowerCase()
    return !lower.includes('/') || r.endsWith(lower) || r.endsWith(`${lower}.md`)
  })
  if (!candidates.length) return null
  candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)
  return describe(root, candidates[0])
}

// ---------------------------------------------------------------------------------------------
// Headings and blocks, for #subpath links

const normHeading = (s) =>
  String(s)
    .replace(/[\[\]#^|*_`~=]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

function findSubpathLine(text, subpath) {
  if (!subpath) return null
  const parts = String(subpath).replace(/^#/, '').split('#').filter(Boolean)
  if (!parts.length) return null
  const lines = text.split(/\r?\n/)
  const last = parts[parts.length - 1]
  if (last.startsWith('^')) {
    const id = last.slice(1)
    const re = new RegExp(`(^|\\s)\\^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
    const i = lines.findIndex((l) => re.test(l))
    return i >= 0 ? i + 1 : null
  }
  const want = normHeading(last)
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence
    if (inFence) continue
    const m = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(lines[i])
    if (m && normHeading(m[1]) === want) return i + 1
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Handlers

export default function activate(orca) {
  const handle = (name, fn) =>
    orca.panels.handle(name, async (input, ctx) => {
      try {
        return await fn(input ?? {}, ctx)
      } catch (error) {
        if (!error.code) orca.log(`${name} failed: ${error.stack || error.message}`)
        throw error
      }
    })

  // Frame errors, so they show in `orca plugin logs` (this Orca does not forward frame consoles).
  handle('canvas.log', async ({ message }) => {
    orca.log(`[frame] ${String(message ?? '').slice(0, 2000)}`)
    return true
  })

  // Picks the vault that holds the canvas: the one that resolves the most file-node paths,
  // preferring the focused workspace (hint) on a tie.
  handle('canvas.locate', async ({ paths = [], hint = '' }) => {
    const roots = await getRoots(orca, true)
    if (!roots.length) return { root: null, name: null, roots: [] }
    const sample = paths.filter((p) => typeof p === 'string').slice(0, 60)
    const hintKey = String(hint || '').toLowerCase()
    let best = null
    for (const r of roots) {
      let score = 0
      for (const p of sample) {
        try {
          if (await exists(await insideRoot(r, p))) score++
        } catch {}
      }
      const hinted = r.workspaces.some((w) => String(w.name || '').toLowerCase() === hintKey) ? 1 : 0
      const rank = score * 2 + hinted
      if (!best || rank > best.rank) best = { rank, score, r }
    }
    if (!best.score && !(best.rank & 1) && roots.length > 1) {
      // Nothing matched and the hint names no workspace: fall back to the first vault.
      best = { r: roots[0], score: 0 }
    }
    return {
      root: best.r.root,
      name: path.basename(best.r.root),
      matched: best.score,
      total: sample.length,
      roots: roots.map((r) => r.root)
    }
  })

  // Batch resolve: items are { path } for file nodes (exact vault path) or { link, from } for
  // [[wikilinks]] and markdown links.
  handle('canvas.resolve', async ({ root, items = [] }) => {
    const r = await requireRoot(orca, root)
    const out = []
    for (const item of items.slice(0, 500)) {
      try {
        if (item && typeof item.path === 'string') out.push(await describe(r, item.path))
        else if (item && typeof item.link === 'string') out.push(await resolveLink(r, item.link, item.from))
        else out.push(null)
      } catch {
        out.push(null)
      }
    }
    return { items: out }
  })

  // Vault files for the note/media pickers and [[ completion.
  handle('canvas.list', async ({ root }) => {
    const r = await requireRoot(orca, root)
    indexes.delete(r.key)
    const index = await getIndex(r)
    let budget = 900 * 1024 // stay under the 1 MiB answer cap
    const files = []
    for (const f of index.files) {
      budget -= f.length * 2 + 4
      if (budget < 0) break
      files.push(f)
    }
    return { files, truncated: files.length < index.files.length }
  })

  // Writes an existing Markdown note, for editing note cards inline. The text arrives in parts
  // (plugin.request inputs are capped at 64 KiB). Refuses if the note changed on disk since
  // `baseMtime`, so an outside edit is never overwritten.
  const pendingWrites = new Map()
  handle('canvas.writeText', async ({ root, path: rel, token, part = 0, parts = 1, text = '', baseMtime }) => {
    const r = await requireRoot(orca, root)
    const abs = await insideRoot(r, rel)
    if (extOf(abs) !== 'md') throw fail('not_permitted', 'only Markdown notes can be written')
    const key = `${token}`
    const chunks = pendingWrites.get(key) ?? []
    chunks[part] = String(text)
    pendingWrites.set(key, chunks)
    if (chunks.filter((c) => c !== undefined).length < parts) return { done: false }
    pendingWrites.delete(key)
    const stat = await fs.stat(abs)
    if (typeof baseMtime === 'number' && Math.abs(stat.mtimeMs - baseMtime) > 1) throw fail('conflict', `${rel} changed on disk`)
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, chunks.join(''), 'utf8')
    await fs.rename(tmp, abs)
    const after = await fs.stat(abs)
    return { done: true, mtime: after.mtimeMs, size: after.size }
  })

  handle('canvas.read', async ({ root, path: rel, offset = 0 }) => {
    const r = await requireRoot(orca, root)
    const abs = await insideRoot(r, rel)
    const handleFile = await fs.open(abs, 'r')
    try {
      const { size } = await handleFile.stat()
      const start = Math.max(0, Math.min(Number(offset) || 0, size))
      const length = Math.min(CHUNK_BYTES, size - start)
      const buffer = Buffer.alloc(length)
      if (length) await handleFile.read(buffer, 0, length, start)
      const next = start + length < size ? start + length : null
      return { size, offset: start, next, base64: buffer.toString('base64') }
    } finally {
      await handleFile.close()
    }
  })

  handle('canvas.text', async ({ root, path: rel }) => {
    const r = await requireRoot(orca, root)
    const abs = await insideRoot(r, rel)
    const stat = await fs.stat(abs)
    const handleFile = await fs.open(abs, 'r')
    try {
      const length = Math.min(stat.size, TEXT_LIMIT)
      const buffer = Buffer.alloc(length)
      await handleFile.read(buffer, 0, length, 0)
      return { text: buffer.toString('utf8'), truncated: stat.size > TEXT_LIMIT }
    } finally {
      await handleFile.close()
    }
  })

  // Opens a vault file in an Orca tab, at the heading or block named by subpath.
  handle('canvas.open', async ({ root, path: rel, subpath }) => {
    const r = await requireRoot(orca, root)
    const abs = await insideRoot(r, rel)
    if (!(await exists(abs))) throw fail('not_found', `${rel} does not exist`)
    let line = null
    if (subpath && extOf(abs) === 'md') {
      try {
        line = findSubpathLine(await fs.readFile(abs, 'utf8'), subpath)
      } catch {}
    }
    const absKey = norm(abs)
    const ws =
      r.workspaces.find((w) => w.path && absKey.startsWith(norm(w.path) + path.sep)) ??
      r.workspaces.find((w) => w.path)
    if (orca.host.has('editor.open') && ws?.id) {
      try {
        await orca.host.call('editor.open', { workspaceId: ws.id, path: abs })
        return { opened: true, line, via: 'editor.open' }
      } catch (error) {
        orca.log(`editor.open failed, falling back to the CLI: ${error.message}`)
      }
    }
    const args = ['file', 'open', abs, '--focus', '--json']
    if (ws?.path) args.push('--worktree', `path:${ws.path}`)
    if (line) args.push('--line', String(line))
    await runCli(args)
    return { opened: true, line, via: 'cli' }
  })
}

// Exported for tests.
export { findSubpathLine, resolveLink }
