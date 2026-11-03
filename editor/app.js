// JSON Canvas (.canvas) editor for Orca's custom-editor frame. It works like Obsidian's canvas, so
// boards move between the two without surprises. Files, images and links go through the plugin's
// worker (worker/main.js), because the frame itself has no file system.

import { renderMarkdown, stripFrontmatter, extractSection } from './markdown.js'
import { serialize, newId, History } from './model.js'
import { icon } from './icons.js'
import { showMenu, closeMenu, isMenuOpen, openSuggester, openPrompt, isModalOpen } from './ui.js'

const orca = window.orca
const $ = (sel, root = document) => root.querySelector(sel)

// ---- Constants ---------------------------------------------------------------------------------

const MIN_ZOOM = -4 // log2 of the scale
const MAX_ZOOM = 1
const ZOOM_BREAKPOINT = -1.7 // at or below: card labels hide, text and notes show placeholders
const ZOOM_STEP = 0.5
const WHEEL_PAN = 0.93
const EASE_BASE = 0.984 // per millisecond
const EDGE_GAP = 7
const MEDIA_CONCURRENCY = 4
const MAX_MEDIA_BYTES = 150 * 1024 * 1024
const TEXT_SIZE = { width: 250, height: 60 }
const FILE_SIZE = { width: 400, height: 400 }
const MIN_SIZE = 50
const SNAP_DISTANCE = 15 // screen px
const DRAG_THRESHOLD = 4

const EXT_KIND = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', avif: 'image',
  ico: 'image', tif: 'image', tiff: 'image', heic: 'image',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', ogv: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio', '3gp': 'audio',
  pdf: 'pdf', md: 'markdown', canvas: 'canvas', base: 'base'
}
const isMediaKind = (k) => k === 'image' || k === 'video' || k === 'audio'
const SIDES = ['top', 'right', 'bottom', 'left']
const RESIZE_DIRS = ['top', 'right', 'bottom', 'left', 'topright', 'bottomright', 'bottomleft', 'topleft']

function el(tag, className, attrs) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  return node
}

const basename = (p) => String(p).slice(String(p).lastIndexOf('/') + 1)
const extname = (p) => {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(i + 1).toLowerCase() : ''
}
const stem = (p) => basename(p).replace(/\.[^.]+$/, '')
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const scaleOf = (zoom) => Math.pow(2, zoom)

// ---- DOM shell ---------------------------------------------------------------------------------

const wrapper = $('#wrapper')
const canvasEl = $('#canvas')
const dotsPattern = $('#canvas-dots')
const toastEl = $('#toast')
const helpEl = $('#help')

const SVG_NS = 'http://www.w3.org/2000/svg'
const edgesSvg = document.createElementNS(SVG_NS, 'svg')
edgesSvg.setAttribute('class', 'jc-edges')
const edgePathsGroup = document.createElementNS(SVG_NS, 'g')
const edgeEndsGroup = document.createElementNS(SVG_NS, 'g')
edgesSvg.append(edgePathsGroup, edgeEndsGroup)
const edgeLabelsEl = el('div', 'jc-edge-labels')
const groupSelectionEl = el('div', 'jc-marquee is-multi')
const boxSelectionEl = el('div', 'jc-marquee')
const snapsSvg = document.createElementNS(SVG_NS, 'svg')
snapsSvg.setAttribute('class', 'jc-guides')
const menuContainer = el('div', 'jc-toolbar-anchor')
const menuEl = el('div', 'jc-toolbar')
menuContainer.append(menuEl)
wrapper.append(menuContainer)

// ---- Bridge to the worker ----------------------------------------------------------------------

async function call(name, input, timeoutMs = 60_000) {
  // Orca checks that input is strict JSON; drop undefined fields first.
  const clean = input === undefined ? undefined : JSON.parse(JSON.stringify(input))
  const result = await orca.host.call('plugin.request', { name, input: clean, timeoutMs })
  return result?.output
}

function reportError(message) {
  call('canvas.log', { message }, 5000).catch(() => {})
}
window.addEventListener('error', (e) => reportError(`${e.message} at ${e.filename}:${e.lineno}:${e.colno}`))
window.addEventListener('unhandledrejection', (e) => reportError(`unhandled: ${e.reason?.stack || e.reason}`))

let toastTimer = 0
function toast(message, ms = 3500) {
  toastEl.textContent = message
  toastEl.classList.add('is-visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), ms)
}

// ---- State -------------------------------------------------------------------------------------

const loadOptions = () => {
  try {
    return { snapToGrid: true, snapToObjects: true, ...JSON.parse(localStorage.getItem('options') || '{}') }
  } catch {
    return { snapToGrid: true, snapToObjects: true }
  }
}

const state = {
  data: { nodes: [], edges: [] },
  index: new Map(), // id -> node
  els: new Map(), // id -> { el, json }
  view: { x: 0, y: 0, zoom: 0 }, // world point at the screen centre, log2 zoom
  target: { x: 0, y: 0, zoom: 0, center: null },
  selNodes: new Set(),
  selEdges: new Set(),
  hasView: false,
  viewKey: null,
  vault: null,
  vaultPromise: null,
  generation: 0,
  readonly: false,
  docReadOnly: false,
  editing: null, // { id, kind, stop(commit) }
  history: new History(),
  docVersion: 0,
  lastSent: null,
  pendingText: null,
  saveTimer: 0,
  saving: null,
  options: loadOptions(),
  pointer: { x: 0, y: 0 }, // last pointer in world coords
  autosize: new Set(), // new media nodes whose height follows the image
  justCreated: new Set() // new text cards removed if left empty
}

const isEditable = () => !state.readonly && !state.docReadOnly
const nodeById = (id) => state.index.get(id)
const edgeById = (id) => state.data.edges.find((e) => e.id === id)

// ---- Vault -------------------------------------------------------------------------------------

function filePaths(data) {
  const paths = []
  for (const n of data.nodes) {
    if (n.type === 'file' && typeof n.file === 'string') paths.push(n.file)
    if (n.type === 'group' && typeof n.background === 'string') paths.push(n.background)
  }
  return paths
}

async function ensureVault() {
  if (state.vault) return state.vault
  if (!state.vaultPromise) {
    state.vaultPromise = (async () => {
      let hint = ''
      try {
        hint = (await orca.host.call('workspace.readContext', {}))?.displayName ?? ''
      } catch {}
      const found = await call('canvas.locate', { paths: filePaths(state.data), hint })
      if (!found?.root) throw new Error('no vault')
      state.vault = { root: found.root, name: found.name }
      return state.vault
    })().catch((error) => {
      state.vaultPromise = null
      console.warn('vault lookup failed', error)
      toast("Couldn't find this canvas's vault. Add its folder under Settings → Plugins → JSON Canvas.", 8000)
      return null
    })
  }
  return state.vaultPromise
}

async function resolveItems(items) {
  const vault = await ensureVault()
  if (!vault || !items.length) return items.map(() => null)
  const out = []
  for (let i = 0; i < items.length; i += 400) {
    const { items: part } = await call('canvas.resolve', { root: vault.root, items: items.slice(i, i + 400) })
    out.push(...part)
  }
  return out
}

let filesCache = null
async function vaultFiles(fresh = false) {
  if (filesCache && !fresh && Date.now() - filesCache.at < 15_000) return filesCache.files
  const vault = await ensureVault()
  if (!vault) return []
  const { files } = await call('canvas.list', { root: vault.root })
  filesCache = { at: Date.now(), files }
  return files
}

// ---- Media loading (chunked through the worker, then blob: URLs) -------------------------------

const mediaCache = new Map()
const mediaQueue = []
let mediaActive = 0

function b64ToBytes(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function pumpMedia() {
  while (mediaActive < MEDIA_CONCURRENCY && mediaQueue.length) {
    const job = mediaQueue.shift()
    mediaActive++
    job()
      .catch(() => {})
      .finally(() => {
        mediaActive--
        pumpMedia()
      })
  }
}

function loadMedia(info) {
  const key = `${info.path}@${info.mtime}`
  let promise = mediaCache.get(key)
  if (!promise) {
    promise = new Promise((resolve, reject) => {
      mediaQueue.push(async () => {
        try {
          const vault = await ensureVault()
          const parts = []
          let offset = 0
          do {
            const chunk = await call('canvas.read', { root: vault.root, path: info.path, offset })
            parts.push(b64ToBytes(chunk.base64))
            offset = chunk.next
          } while (offset != null)
          resolve(URL.createObjectURL(new Blob(parts, { type: info.mime || 'application/octet-stream' })))
        } catch (error) {
          mediaCache.delete(key)
          reject(error)
        }
      })
      pumpMedia()
    })
    mediaCache.set(key, promise)
  }
  return promise
}

let lazyMedia = []
function queueLazy(id, start) {
  lazyMedia.push({ id, start })
  scheduleLazyCheck()
}
let lazyFrame = 0
function scheduleLazyCheck() {
  if (lazyFrame) return
  lazyFrame = requestAnimationFrame(() => {
    lazyFrame = 0
    if (!lazyMedia.length) return
    const { x, y, zoom } = state.view
    const s = scaleOf(zoom)
    const hw = (wrapper.clientWidth || 800) / s
    const hh = (wrapper.clientHeight || 600) / s
    const vx = x - 1.5 * hw
    const vy = y - 1.5 * hh
    const keep = []
    const now = []
    for (const item of lazyMedia) {
      const n = nodeById(item.id)
      if (!n) continue
      const b = nodeBox(n)
      const visible = b.x < vx + 3 * hw && b.x + b.width > vx && b.y < vy + 3 * hh && b.y + b.height > vy
      ;(visible ? now : keep).push({ ...item, b })
    }
    lazyMedia = keep.map(({ id, start }) => ({ id, start }))
    now.sort((a, b) => dist(a.b, x, y) - dist(b.b, x, y))
    for (const item of now) item.start()
  })
}
const dist = (b, cx, cy) => Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy)

// ---- Colors ------------------------------------------------------------------------------------

function applyColor(target, color) {
  for (let i = 1; i <= 6; i++) target.classList.remove(`jc-color-${i}`)
  target.classList.remove('has-color')
  target.style.removeProperty('--jc-color')
  if (color == null || color === '') return false
  const c = String(color).trim()
  if (/^[1-6]$/.test(c)) target.classList.add(`jc-color-${c}`)
  else if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) target.style.setProperty('--jc-color', c)
  else return false
  target.classList.add('has-color')
  return true
}

function parseColor(value) {
  const v = value.trim()
  let m = /^#([0-9a-f]{3})$/i.exec(v)
  if (m) return m[1].split('').map((h) => parseInt(h + h, 16))
  m = /^#([0-9a-f]{6})$/i.exec(v)
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16))
  m = /^rgba?\(([^)]+)\)/i.exec(v)
  if (m) return m[1].split(/[ ,/]+/).slice(0, 3).map(Number)
  return null
}

function toHex(value) {
  const rgb = parseColor(value || '')
  return rgb ? '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('') : '#000000'
}

function updateLabelForegrounds() {
  for (const label of canvasEl.querySelectorAll('.jc-card-group.has-color .jc-group-title')) {
    const rgb = parseColor(getComputedStyle(label).getPropertyValue('--jc-color'))
    label.classList.remove('text-light', 'text-dark')
    if (!rgb) continue
    const [r, g, b] = rgb.map((c) => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    label.classList.add(0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? 'text-dark' : 'text-light')
  }
}

// ---- Node rendering ----------------------------------------------------------------------------

function nodeBox(n) {
  return {
    x: Number(n.x) || 0,
    y: Number(n.y) || 0,
    width: Number(n.width) > 0 ? Number(n.width) : 250,
    height: Number(n.height) > 0 ? Number(n.height) : 60
  }
}

function markdownView(sizer) {
  const content = el('div', 'jc-card-body jc-md-host')
  const embedContent = el('div', 'jc-md-inner')
  const view = el('div', 'jc-md-scroll jc-md')
  view.append(sizer)
  embedContent.append(view)
  content.append(embedContent)
  return { content, view }
}

function breakpointPlaceholder(text) {
  const ph = el('div', 'jc-card-placeholder is-far-view')
  ph.textContent = text || ''
  return ph
}

function fileLabel(file, subpath) {
  if (extname(file) === 'md') return stem(file) + (subpath ? ` › ${subpath.replace(/^#/, '')}` : '')
  return basename(file)
}

function setGeometry(node, n) {
  const box = nodeBox(n)
  node.style.transform = `translate(${box.x}px, ${box.y}px)`
  node.style.width = `${box.width}px`
  node.style.height = `${box.height}px`
  node.style.setProperty('--jc-w', `${box.width}px`)
  node.style.setProperty('--jc-h', `${box.height}px`)
}

function addInteractionLayer(node) {
  for (const dir of RESIZE_DIRS) {
    const r = el('div', 'jc-handle')
    r.dataset.resize = dir
    if (SIDES.includes(dir)) {
      const cp = el('div', 'jc-port')
      cp.dataset.side = dir
      r.append(cp)
    }
    node.append(r)
  }
}

function renderNode(n, generation) {
  const node = el('div', `jc-card jc-card-${n.type === 'group' ? 'group' : n.type || 'text'}`)
  node.dataset.id = n.id
  setGeometry(node, n)
  applyColor(node, n.color)
  const container = el('div', 'jc-card-frame')
  node.append(container)

  const addLabel = (text) => {
    const label = el('div', 'jc-card-caption')
    label.textContent = text
    label.title = text
    node.append(label)
    return label
  }

  if (n.type === 'group') {
    const content = el('div', 'jc-card-body')
    container.append(content)
    if (typeof n.background === 'string' && n.background) {
      resolveItems([{ path: n.background }]).then(([info]) => {
        if (!info || info.kind !== 'image' || generation !== state.generation) return
        queueLazy(n.id, () =>
          loadMedia(info).then((url) => {
            if (n.backgroundStyle === 'repeat') {
              const bg = el('div', 'jc-group-bg is-tile')
              bg.style.backgroundImage = `url("${url}")`
              content.prepend(bg)
            } else {
              const img = el('img', `jc-group-bg${n.backgroundStyle === 'ratio' ? ' is-contain' : ''}`)
              img.src = url
              img.alt = ''
              content.prepend(img)
            }
          })
        )
      })
    }
    if (n.label) {
      const label = el('div', 'jc-group-title')
      label.textContent = n.label
      label.title = n.label
      node.append(label)
    }
    addInteractionLayer(node)
    return node
  }

  container.append(el('div', 'jc-card-shield'))
  addInteractionLayer(node)

  if (n.type === 'text' || !n.type) {
    node.classList.add('can-collapse')
    const { content, view } = markdownView(renderMarkdown(n.text ?? ''))
    container.prepend(content)
    container.append(breakpointPlaceholder(''))
    hydrateMarkdown(view, null, generation)
    return node
  }

  if (n.type === 'link') {
    const url = String(n.url ?? '')
    let host = url
    try {
      host = new URL(url).hostname.replace(/^www\./, '')
    } catch {}
    const content = el('div', 'jc-card-body')
    const ph = el('div', 'jc-card-placeholder is-link')
    ph.innerHTML = icon('globe')
    const title = el('div')
    title.textContent = host || 'Link'
    const small = el('small')
    small.textContent = url
    small.dataset.external = url
    ph.append(title, small)
    content.append(ph)
    container.prepend(content)
    addLabel(url)
    return node
  }

  if (n.type === 'file') {
    const file = String(n.file ?? '')
    const kind = EXT_KIND[extname(file)] ?? 'other'
    const content = el('div', 'jc-card-body')
    container.prepend(content)
    const labelText = fileLabel(file, n.subpath)
    addLabel(labelText)
    if (!isMediaKind(kind)) {
      node.classList.add('can-collapse')
      container.append(breakpointPlaceholder(labelText))
    }
    node.dataset.file = file
    if (n.subpath) node.dataset.subpath = n.subpath

    resolveItems([{ path: file }]).then(async ([info]) => {
      if (generation !== state.generation || !node.isConnected) return
      if (!info) {
        const empty = el('div', 'jc-missing')
        empty.textContent = `"${file}" could not be found.`
        content.replaceChildren(empty)
        return
      }
      node.dataset.resolved = info.path
      node.dataset.mtime = String(info.mtime)
      if (isMediaKind(info.kind)) {
        content.className = `jc-card-body jc-media jc-media-${info.kind}`
        if (info.size > MAX_MEDIA_BYTES) {
          content.replaceChildren(placeholder('film', basename(file), 'Too large to preview · double-click to open'))
          return
        }
        queueLazy(n.id, () =>
          loadMedia(info).then((url) => {
            if (!node.isConnected) return
            let media
            if (info.kind === 'image') {
              media = el('img')
              media.alt = basename(file)
              media.draggable = false
              media.addEventListener('load', () => autosizeMedia(n.id, media.naturalWidth, media.naturalHeight), { once: true })
            } else {
              media = el(info.kind)
              media.controls = true
              media.preload = 'metadata'
              if (info.kind === 'video')
                media.addEventListener('loadedmetadata', () => autosizeMedia(n.id, media.videoWidth, media.videoHeight), { once: true })
            }
            media.src = url
            content.replaceChildren(media)
          })
        )
      } else if (info.kind === 'markdown') {
        const { text } = await call('canvas.text', { root: state.vault.root, path: info.path })
        if (generation !== state.generation || !node.isConnected) return
        let body = stripFrontmatter(text)
        if (n.subpath) body = extractSection(body, n.subpath) ?? `*${n.subpath} not found in ${stem(file)}*`
        const sizer = renderMarkdown(body)
        if (!n.subpath) {
          const title = el('div', 'jc-md-title')
          title.textContent = stem(file)
          sizer.prepend(title)
        }
        const md = markdownView(sizer)
        content.replaceWith(md.content)
        hydrateMarkdown(md.view, info.path, generation)
      } else {
        const iconName = info.kind === 'pdf' ? 'pdf' : info.kind === 'canvas' ? 'canvas' : 'file'
        content.replaceChildren(placeholder(iconName, basename(file), 'Double-click to open in Orca'))
      }
    })
    return node
  }

  const { content } = markdownView(renderMarkdown(`*Unsupported node type: ${n.type}*`))
  container.prepend(content)
  return node
}

function placeholder(iconName, title, note) {
  const ph = el('div', 'jc-card-placeholder')
  ph.innerHTML = icon(iconName)
  const t = el('div')
  t.textContent = title
  ph.append(t)
  if (note) {
    const s = el('small')
    s.textContent = note
    ph.append(s)
  }
  return ph
}

// A media card created here takes the image's aspect ratio, as in Obsidian.
function autosizeMedia(id, w, h) {
  if (!state.autosize.has(id) || !w || !h) return
  state.autosize.delete(id)
  const n = nodeById(id)
  if (!n) return
  n.height = Math.round((n.width * h) / w)
  sync()
  commit({ amend: true })
}

async function hydrateMarkdown(view, sourcePath, generation, depth = 0) {
  const links = [...view.querySelectorAll('a.jc-link-internal')].filter((a) => a.dataset.target)
  const embeds = [...view.querySelectorAll('.jc-embed[data-target]')]
  if (!links.length && !embeds.length) return
  const items = [...links, ...embeds].map((x) => ({ link: x.dataset.target, from: sourcePath ?? undefined }))
  const resolved = await resolveItems(items)
  if (generation !== state.generation) return
  links.forEach((a, i) => {
    const info = resolved[i]
    if (info) a.dataset.resolved = info.path
    else a.classList.add('is-unresolved')
  })
  embeds.forEach((span, i) => fillEmbed(span, resolved[links.length + i], generation, depth))
}

function fillEmbed(span, info, generation, depth) {
  const target = span.dataset.target
  const alias = span.dataset.alias || ''
  if (!info) {
    span.classList.add('jc-embed-missing')
    span.textContent = `"${target}" could not be found.`
    return
  }
  if (info.kind === 'image') {
    span.classList.add('jc-embed-image', 'jc-media')
    const img = el('img')
    img.alt = alias || basename(info.path)
    const size = /^(\d+)(?:x(\d+))?$/.exec(alias)
    if (size) {
      img.setAttribute('width', size[1])
      if (size[2]) img.setAttribute('height', size[2])
      img.alt = basename(info.path)
    }
    span.append(img)
    loadMedia(info).then((url) => (img.src = url))
    return
  }
  if (info.kind === 'markdown' && depth < 2) {
    const block = el('div', 'jc-md-host jc-embed-note')
    span.replaceWith(block)
    call('canvas.text', { root: state.vault.root, path: info.path }).then(({ text }) => {
      if (generation !== state.generation) return
      let body = stripFrontmatter(text)
      if (span.dataset.subpath) body = extractSection(body, span.dataset.subpath) ?? ''
      block.append(renderMarkdown(body))
      hydrateMarkdown(block, info.path, generation, depth + 1)
    })
    return
  }
  const a = el('a', 'jc-link-internal')
  a.dataset.target = target
  a.dataset.subpath = span.dataset.subpath || ''
  a.dataset.resolved = info.path
  a.textContent = alias || basename(info.path)
  span.replaceWith(a)
}

// ---- Sync data -> DOM --------------------------------------------------------------------------

const geometryKeys = new Set(['x', 'y', 'width', 'height'])
const withoutGeometry = (n) => JSON.stringify(Object.fromEntries(Object.entries(n).filter(([k]) => !geometryKeys.has(k))))

function sync({ full = false } = {}) {
  if (full) state.generation++
  const generation = state.generation
  const nodes = state.data.nodes.filter((n) => n && n.id != null)
  state.data.nodes = nodes
  state.index = new Map(nodes.map((n) => [n.id, n]))
  for (const [id, entry] of state.els) {
    if (!state.index.has(id) || full) {
      if (state.editing?.id === id && !full && state.index.has(id)) continue
      entry.el.remove()
      state.els.delete(id)
    }
  }
  for (const id of [...state.selNodes]) if (!state.index.has(id)) state.selNodes.delete(id)
  const edgeIds = new Set(state.data.edges.map((e) => e.id))
  for (const id of [...state.selEdges]) if (!edgeIds.has(id)) state.selEdges.delete(id)

  for (const n of nodes) {
    const json = JSON.stringify(n)
    const entry = state.els.get(n.id)
    if (entry && entry.json === json) continue
    if (entry && (state.editing?.id === n.id || entry.shape === withoutGeometry(n))) {
      setGeometry(entry.el, n)
      entry.json = json
      continue
    }
    const node = renderNode(n, generation)
    if (entry) entry.el.replaceWith(node)
    state.els.set(n.id, { el: node, json, shape: withoutGeometry(n) })
  }

  // Order: groups (larger below smaller), edges, cards in document order, then overlays.
  const groups = nodes.filter((n) => n.type === 'group')
  groups.sort((a, b) => nodeBox(b).width * nodeBox(b).height - nodeBox(a).width * nodeBox(a).height)
  const order = [
    ...groups.map((n) => state.els.get(n.id).el),
    edgesSvg,
    ...nodes.filter((n) => n.type !== 'group').map((n) => state.els.get(n.id).el),
    edgeLabelsEl,
    groupSelectionEl,
    boxSelectionEl,
    snapsSvg
  ]
  const current = [...canvasEl.children]
  if (current.length !== order.length || order.some((x, i) => current[i] !== x)) {
    for (const x of order) canvasEl.append(x)
    for (const x of [...canvasEl.children]) if (!order.includes(x)) x.remove()
  }
  renderEdges()
  updateLabelForegrounds()
  updateSelectionUI(true)
  scheduleLazyCheck()
  if (nodes.length) document.getElementById('canvas-message')?.remove()
}

// ---- Edges (Obsidian's geometry) ---------------------------------------------------------------

const ARROW_ROTATION = { top: 180, bottom: 0, left: 90, right: 270 }

function sideAnchor(box, side) {
  switch (side) {
    case 'top':
      return { x: box.x + box.width / 2, y: box.y }
    case 'bottom':
      return { x: box.x + box.width / 2, y: box.y + box.height }
    case 'left':
      return { x: box.x, y: box.y + box.height / 2 }
    default:
      return { x: box.x + box.width, y: box.y + box.height / 2 }
  }
}

function offsetFrom(p, side, d) {
  switch (side) {
    case 'top':
      return { x: p.x, y: p.y - d }
    case 'bottom':
      return { x: p.x, y: p.y + d }
    case 'left':
      return { x: p.x - d, y: p.y }
    default:
      return { x: p.x + d, y: p.y }
  }
}

function facingSide(a, b) {
  const r = Math.atan2(b.y + b.height / 2 - (a.y + a.height / 2), b.x + b.width / 2 - (a.x + a.width / 2))
  const o = Math.atan2(a.height, a.width)
  if (r > -o && r <= o) return 'right'
  if (r > o && r <= Math.PI - o) return 'bottom'
  if (r > Math.PI - o || r <= -(Math.PI - o)) return 'left'
  return 'top'
}

// The side of a card nearest a point, for dropping an edge.
function nearestSide(box, p) {
  const d = {
    top: Math.abs(p.y - box.y),
    bottom: Math.abs(p.y - (box.y + box.height)),
    left: Math.abs(p.x - box.x),
    right: Math.abs(p.x - (box.x + box.width))
  }
  return Object.entries(d).sort((a, b) => a[1] - b[1])[0][0]
}

function edgeGeometry(e) {
  const from = nodeById(e.fromNode)
  const to = nodeById(e.toNode)
  if (!from || !to) return null
  const a = nodeBox(from)
  const b = nodeBox(to)
  const fromSide = ARROW_ROTATION[e.fromSide] != null ? e.fromSide : facingSide(a, b)
  const toSide = ARROW_ROTATION[e.toSide] != null ? e.toSide : facingSide(b, a)
  return pathBetween(sideAnchor(a, fromSide), fromSide, sideAnchor(b, toSide), toSide, e)
}

function pathBetween(A, fromSide, L, toSide, e = {}) {
  const fromArrow = (e.fromEnd ?? 'none') === 'arrow'
  const toArrow = (e.toEnd ?? 'arrow') === 'arrow'
  const S = offsetFrom(A, fromSide, EDGE_GAP)
  const C = offsetFrom(L, toSide, EDGE_GAP)
  const off = clamp(Math.hypot(C.x - S.x, C.y - S.y) / 2, 70, 150)
  const cp1 = offsetFrom(S, fromSide, off)
  const cp2 = offsetFrom(C, toSide, off)
  let d = `M${S.x},${S.y} C${cp1.x},${cp1.y} ${cp2.x},${cp2.y} ${C.x},${C.y}`
  if (!fromArrow) d = `M${A.x} ${A.y} L${S.x} ${S.y} ${d}`
  if (!toArrow) d = `${d} M${C.x} ${C.y} L${L.x} ${L.y}`
  const mid = { x: (S.x + 3 * cp1.x + 3 * cp2.x + C.x) / 8, y: (S.y + 3 * cp1.y + 3 * cp2.y + C.y) / 8 }
  return { d, A, L, fromSide, toSide, fromArrow, toArrow, mid }
}

function arrowEnd(parent, point, side, color, id) {
  const g = document.createElementNS(SVG_NS, 'g')
  if (id) g.dataset.end = id
  applyColor(g, color)
  if (id && state.selEdges.has(id)) g.classList.add('is-focused')
  g.style.transform = `translate(${point.x}px, ${point.y}px) rotate(${ARROW_ROTATION[side]}deg)`
  const poly = document.createElementNS(SVG_NS, 'polygon')
  poly.setAttribute('class', 'jc-edge-arrow')
  poly.setAttribute('points', '0,0 6.5,10.4 -6.5,10.4')
  g.append(poly)
  parent.append(g)
}

let tempEdge = null // { A, fromSide, L, toSide }
let editingEdgeId = null

function renderEdges() {
  edgePathsGroup.replaceChildren()
  edgeEndsGroup.replaceChildren()
  edgeLabelsEl.replaceChildren()
  for (const e of state.data.edges) {
    const geo = edgeGeometry(e)
    if (!geo) continue
    const g = document.createElementNS(SVG_NS, 'g')
    g.dataset.id = e.id
    applyColor(g, e.color)
    if (state.selEdges.has(e.id)) g.classList.add('is-focused')
    const display = document.createElementNS(SVG_NS, 'path')
    display.setAttribute('class', 'jc-edge-line')
    display.setAttribute('d', geo.d)
    const hit = document.createElementNS(SVG_NS, 'path')
    hit.setAttribute('class', 'jc-edge-hit')
    hit.setAttribute('d', geo.d)
    g.append(display, hit)
    edgePathsGroup.append(g)
    if (geo.fromArrow) arrowEnd(edgeEndsGroup, geo.A, geo.fromSide, e.color, e.id)
    if (geo.toArrow) arrowEnd(edgeEndsGroup, geo.L, geo.toSide, e.color, e.id)
    if (e.label && editingEdgeId !== e.id) {
      const wrap = el('div', 'jc-edge-label-anchor')
      wrap.dataset.id = e.id
      wrap.style.transform = `translate(${geo.mid.x}px, ${geo.mid.y}px)`
      const label = el('div', 'jc-edge-label')
      label.textContent = e.label
      wrap.append(label)
      edgeLabelsEl.append(wrap)
    }
  }
  if (tempEdge) {
    const geo = pathBetween(tempEdge.A, tempEdge.fromSide, tempEdge.L, tempEdge.toSide, {})
    const g = document.createElementNS(SVG_NS, 'g')
    g.classList.add('is-focused')
    const display = document.createElementNS(SVG_NS, 'path')
    display.setAttribute('class', 'jc-edge-line')
    display.setAttribute('d', geo.d)
    g.append(display)
    edgePathsGroup.append(g)
    arrowEnd(edgeEndsGroup, geo.L, geo.toSide, null, null)
  }
}

// ---- Camera ------------------------------------------------------------------------------------

const gridSpacing = (zoom) => (zoom < -3.3 ? 160 : zoom < -2.16 ? 80 : zoom < -0.91 ? 40 : 20)

let lastMultiplier = 0
function applyView() {
  const { x, y, zoom } = state.view
  const w = wrapper.clientWidth || 800
  const h = wrapper.clientHeight || 600
  const s = scaleOf(zoom)
  canvasEl.style.transform = `translate(${w / 2}px, ${h / 2}px) scale(${s}) translate(${-x}px, ${-y}px)`
  const D = gridSpacing(zoom)
  dotsPattern.setAttribute('x', String(w / 2 - (x % D) * s))
  dotsPattern.setAttribute('y', String(h / 2 - (y % D) * s))
  dotsPattern.setAttribute('width', String(D * s))
  dotsPattern.setAttribute('height', String(D * s))
  wrapper.classList.toggle('is-far', zoom <= ZOOM_BREAKPOINT)
  const m = Math.sqrt(1 / s)
  if (Math.abs(m - lastMultiplier) > lastMultiplier * 0.004) {
    lastMultiplier = m
    wrapper.style.setProperty('--jc-ui-scale', String(m))
  }
  positionSelectionMenu()
  scheduleLazyCheck()
}

let tickFrame = 0
let lastTick = 0
let finishAnimation = false
function requestTick() {
  if (tickFrame) return
  lastTick = performance.now()
  tickFrame = requestAnimationFrame(tick)
}

function tick(now) {
  tickFrame = 0
  const dt = Math.max(1, Math.min(64, now - lastTick))
  lastTick = now
  const v = state.view
  const t = state.target
  t.zoom = clamp(t.zoom, MIN_ZOOM, MAX_ZOOM)
  let a = 1 - Math.pow(EASE_BASE, dt)
  if (finishAnimation) {
    a = 1
    finishAnimation = false
  }
  const g = t.zoom - v.zoom
  if (g !== 0) {
    const before = scaleOf(v.zoom)
    v.zoom = Math.abs(g) < 0.01 ? t.zoom : v.zoom + g * a
    const after = scaleOf(v.zoom)
    if (t.center) {
      const dx = t.center.x / after - t.center.x / before
      const dy = t.center.y / after - t.center.y / before
      v.x -= dx
      v.y -= dy
      t.x -= dx
      t.y -= dy
    }
  }
  const kx = t.x - v.x
  v.x = Math.abs(kx) < 0.01 ? t.x : v.x + kx * a
  const ky = t.y - v.y
  v.y = Math.abs(ky) < 0.01 ? t.y : v.y + ky * a
  applyView()
  if (v.x !== t.x || v.y !== t.y || v.zoom !== t.zoom) requestTick()
  else {
    t.center = null
    saveViewSoon()
  }
}

function setViewNow(x, y, zoom) {
  state.view = { x, y, zoom }
  state.target = { x, y, zoom, center: null }
  applyView()
}

function panBy(dxScreen, dyScreen) {
  const s = scaleOf(state.view.zoom)
  state.view.x -= dxScreen / s
  state.view.y -= dyScreen / s
  state.target.x -= dxScreen / s
  state.target.y -= dyScreen / s
  applyView()
  saveViewSoon()
}

function zoomBy(delta, center) {
  state.target.zoom += delta
  state.target.center = center ?? { x: 0, y: 0 }
  requestTick()
}

function zoomToBbox(box) {
  const w = wrapper.clientWidth || 800
  const h = wrapper.clientHeight || 600
  const ratio = Math.min(w / (1.1 * Math.max(box.width, 1)), h / (1.1 * Math.max(box.height, 1)))
  state.target = { x: box.x + box.width / 2, y: box.y + box.height / 2, zoom: Math.log2(Math.min(ratio, 1)), center: null }
  requestTick()
}

function bounds(boxes) {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const b of boxes) {
    x1 = Math.min(x1, b.x)
    y1 = Math.min(y1, b.y)
    x2 = Math.max(x2, b.x + b.width)
    y2 = Math.max(y2, b.y + b.height)
  }
  return Number.isFinite(x1) ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null
}

function zoomToFit(immediate = false) {
  const box = bounds(state.data.nodes.map(nodeBox))
  if (!box) return
  zoomToBbox(box)
  if (immediate) finishAnimation = true
}

function selectionBoxes() {
  const boxes = [...state.selNodes].map((id) => nodeById(id)).filter(Boolean).map(nodeBox)
  for (const id of state.selEdges) {
    const e = edgeById(id)
    const geo = e && edgeGeometry(e)
    if (geo) boxes.push({ x: Math.min(geo.A.x, geo.L.x), y: Math.min(geo.A.y, geo.L.y), width: Math.abs(geo.A.x - geo.L.x), height: Math.abs(geo.A.y - geo.L.y) })
  }
  return boxes
}

function zoomToSelection() {
  const box = bounds(selectionBoxes())
  if (box) zoomToBbox(box)
  else zoomToFit()
}

let saveViewTimer = 0
function saveViewSoon() {
  clearTimeout(saveViewTimer)
  saveViewTimer = setTimeout(() => {
    if (!state.viewKey) return
    try {
      const { x, y, zoom } = state.target
      localStorage.setItem(state.viewKey, JSON.stringify({ x, y, zoom }))
    } catch {}
  }, 400)
}

function viewKeyFor(data) {
  const ids = (data.nodes ?? []).map((n) => n.id).sort().join('|')
  let h = 2166136261
  for (let i = 0; i < ids.length; i++) h = Math.imul(h ^ ids.charCodeAt(i), 16777619)
  return `view2:${(h >>> 0).toString(36)}:${ids.length}`
}

// Screen (client) point -> world point.
function toWorld(clientX, clientY) {
  const rect = wrapper.getBoundingClientRect()
  const s = scaleOf(state.view.zoom)
  return { x: state.view.x + (clientX - rect.left - rect.width / 2) / s, y: state.view.y + (clientY - rect.top - rect.height / 2) / s }
}

function toScreen(x, y) {
  const s = scaleOf(state.view.zoom)
  return { x: (x - state.view.x) * s + wrapper.clientWidth / 2, y: (y - state.view.y) * s + wrapper.clientHeight / 2 }
}

const viewCenter = () => ({ x: state.view.x, y: state.view.y })

// ---- Saving ------------------------------------------------------------------------------------

// Records the current data as an undo step and saves it to the file through Orca.
function commit({ amend = false } = {}) {
  const text = serialize(state.data)
  const changed = amend ? state.history.amend(text) : state.history.push(text)
  if (!changed && text === state.lastSent) return
  queueSave(text)
  updateHistoryButtons()
}

function queueSave(text) {
  state.pendingText = text
  clearTimeout(state.saveTimer)
  state.saveTimer = setTimeout(flushSave, 250)
}

async function flushSave() {
  clearTimeout(state.saveTimer)
  if (state.saving) await state.saving
  const text = state.pendingText
  state.pendingText = null
  if (text == null || text === state.lastSent) return
  state.saving = (async () => {
    try {
      await orca.document.applyEdit({ baseVersion: state.docVersion, content: { kind: 'text', text } })
      state.lastSent = text
    } catch (error) {
      if (error?.code === 'conflict') toast('The canvas changed on disk. Showing the newer version.', 5000)
      else if (error?.code === 'not_permitted') setDocReadOnly(true)
      else toast(`Couldn't save: ${error?.message || error?.code}`, 6000)
      reportError(`save failed: ${error?.code} ${error?.message}`)
    } finally {
      state.saving = null
    }
  })()
  return state.saving
}

orca.on?.('editor.flush', async () => {
  state.editing?.flush?.()
  await flushSave()
})
window.addEventListener('pagehide', () => {
  state.editing?.flush?.()
  flushSave()
})

function applyLocalText(text) {
  stopEditing(false)
  state.data = normalize(JSON.parse(text))
  sync()
  queueSave(text)
  updateHistoryButtons()
}

function undo() {
  if (!isEditable()) return
  const text = state.history.undo()
  if (text != null) applyLocalText(text)
}

function redo() {
  if (!isEditable()) return
  const text = state.history.redo()
  if (text != null) applyLocalText(text)
}

function updateHistoryButtons() {
  $('[data-action="undo"]')?.classList.toggle('is-disabled', !state.history.canUndo)
  $('[data-action="redo"]')?.classList.toggle('is-disabled', !state.history.canRedo)
}

// ---- Read-only ---------------------------------------------------------------------------------

function setReadonly(value) {
  state.readonly = value
  try {
    if (state.viewKey) localStorage.setItem(`readonly:${state.viewKey}`, value ? '1' : '0')
  } catch {}
  if (value) stopEditing(true)
  updateModeUI()
}

function setDocReadOnly(value) {
  if (state.docReadOnly === value) return
  state.docReadOnly = value
  if (value) stopEditing(false)
  updateModeUI()
}

function updateModeUI() {
  const ro = !isEditable()
  wrapper.classList.toggle('is-locked', ro)
  const btn = $('[data-action="mode"]')
  if (btn) {
    btn.innerHTML = icon(ro ? 'lock' : 'settings')
    btn.title = ro ? (state.docReadOnly ? 'This file is read-only' : 'Read-only. Click to edit') : 'Canvas settings'
    btn.classList.toggle('is-active', ro)
  }
  updateSelectionUI(true)
}

// ---- Selection ---------------------------------------------------------------------------------

function selectOnly(id, kind = 'node') {
  state.selNodes.clear()
  state.selEdges.clear()
  if (id != null) (kind === 'edge' ? state.selEdges : state.selNodes).add(id)
  updateSelectionUI(true)
}

function toggleSelect(id, kind = 'node') {
  const set = kind === 'edge' ? state.selEdges : state.selNodes
  if (set.has(id)) set.delete(id)
  else set.add(id)
  updateSelectionUI(true)
}

function deselectAll() {
  if (!state.selNodes.size && !state.selEdges.size) return
  state.selNodes.clear()
  state.selEdges.clear()
  updateSelectionUI(true)
}

function selectAll() {
  state.selEdges.clear()
  state.selNodes = new Set(state.data.nodes.map((n) => n.id))
  updateSelectionUI(true)
}

const selectionSize = () => state.selNodes.size + state.selEdges.size

let menuDirty = true
let draggingNow = false

// Obsidian: one selected item is "focused" (its content is live); several are "selected", with a
// box around them that drags them all.
function updateSelectionUI(rebuildMenu = false) {
  const single = selectionSize() === 1
  for (const [id, entry] of state.els) {
    const sel = state.selNodes.has(id)
    entry.el.classList.toggle('is-focused', sel && single)
    entry.el.classList.toggle('is-selected', sel && !single)
    const n = nodeById(id)
    entry.el.style.zIndex = sel && single && n?.type !== 'group' ? '1000' : ''
  }
  for (const g of edgesSvg.querySelectorAll('g[data-id], g[data-end]')) {
    g.classList.toggle('is-focused', state.selEdges.has(g.dataset.id || g.dataset.end))
  }
  const box = !single && selectionSize() > 1 ? bounds(selectionBoxes()) : null
  if (box) {
    groupSelectionEl.style.display = 'block'
    groupSelectionEl.style.transform = `translate(${box.x}px, ${box.y}px)`
    groupSelectionEl.style.width = `${box.width}px`
    groupSelectionEl.style.height = `${box.height}px`
  } else groupSelectionEl.style.display = 'none'
  if (rebuildMenu) menuDirty = true
  renderSelectionMenu()
}

// ---- Selection menu (floating above the selection) --------------------------------------------

let submenu = null

function menuButton(title, iconName, onClick) {
  const b = el('button', 'jc-icon-button')
  b.title = title
  b.setAttribute('aria-label', title)
  b.innerHTML = icon(iconName)
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick(e)
  })
  menuEl.append(b)
  return b
}

function selectedItems() {
  return [...[...state.selNodes].map(nodeById).filter(Boolean), ...[...state.selEdges].map(edgeById).filter(Boolean)]
}

function colorSubmenu(anchor, items) {
  if (submenu) {
    submenu.remove()
    anchor.classList.remove('is-active')
    const was = submenu.dataset.kind
    submenu = null
    if (was === 'color') return
  }
  anchor.classList.add('is-active')
  submenu = el('div', 'jc-toolbar-popout')
  submenu.dataset.kind = 'color'
  const current = items[items.length - 1]?.color ?? ''
  let matched = false
  const set = (color, close = true) => {
    for (const item of items) {
      if (color) item.color = color
      else delete item.color
    }
    sync()
    commit({ amend: !close })
    if (close) closeSubmenu()
  }
  const swatch = (c) => {
    const item = el('div', 'jc-swatch')
    if (c) item.classList.add(`jc-color-${c}`)
    if (String(current) === c) {
      item.classList.add('is-active')
      matched = true
    }
    item.title = c ? ['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Purple'][Number(c) - 1] : 'No color'
    item.addEventListener('click', () => set(c))
    submenu.append(item)
  }
  swatch('')
  for (let i = 1; i <= 6; i++) swatch(String(i))
  const custom = el('div', 'jc-swatch is-custom')
  const input = el('input')
  input.type = 'color'
  custom.style.setProperty('--jc-color', '#000000')
  if (!matched && current) {
    input.value = toHex(String(current))
    custom.style.setProperty('--jc-color', input.value)
    custom.classList.add('is-active')
  }
  let first = true
  input.addEventListener('input', () => {
    set(input.value, false)
    first = false
  })
  input.addEventListener('change', () => set(input.value, true))
  custom.title = 'Custom color'
  custom.append(input)
  submenu.append(custom)
  menuEl.append(submenu)
}

function closeSubmenu() {
  submenu?.remove()
  submenu = null
  menuEl.querySelector('.is-active')?.classList.remove('is-active')
}

function containedNodes(group) {
  const g = nodeBox(group)
  return state.data.nodes.filter((n) => {
    if (n === group) return false
    const b = nodeBox(n)
    return b.x >= g.x && b.y >= g.y && b.x + b.width <= g.x + g.width && b.y + b.height <= g.y + g.height
  })
}

function alignTargets() {
  const nodes = [...state.selNodes].map(nodeById).filter(Boolean)
  if (nodes.length === 1 && nodes[0].type === 'group') {
    const g = nodeBox(nodes[0])
    return [containedNodes(nodes[0]), { x: g.x + 20, y: g.y + 20, width: g.width - 40, height: g.height - 40 }]
  }
  return [nodes, bounds(nodes.map(nodeBox))]
}

function align(kind) {
  const [nodes, b] = alignTargets()
  if (!b || !nodes.length) return
  const G = gridSpacing(state.view.zoom)
  for (const n of nodes) {
    if (kind === 'left') n.x = b.x
    else if (kind === 'right') n.x = b.x + b.width - n.width
    else if (kind === 'top') n.y = b.y
    else if (kind === 'bottom') n.y = b.y + b.height - n.height
    else if (kind === 'center') n.x = b.x + (b.width - n.width) / 2
    else if (kind === 'middle') n.y = b.y + (b.height - n.height) / 2
  }
  if (nodes.length > 1) {
    if (kind === 'distribute-h' || kind === 'distribute-v') {
      const horiz = kind === 'distribute-h'
      const total = nodes.reduce((s, n) => s + (horiz ? n.width : n.height), 0)
      nodes.sort((p, q) => (horiz ? p.x - q.x || p.y - q.y : p.y - q.y || p.x - q.x))
      const gap = ((horiz ? b.width : b.height) - total) / (nodes.length - 1)
      for (let i = 1; i < nodes.length - 1; i++) {
        const prev = nodes[i - 1]
        if (horiz) nodes[i].x = prev.x + prev.width + gap
        else nodes[i].y = prev.y + prev.height + gap
      }
    } else if (kind === 'stretch-h') for (const n of nodes) (n.x = b.x), (n.width = b.width)
    else if (kind === 'stretch-v') for (const n of nodes) (n.y = b.y), (n.height = b.height)
    else if (kind === 'arrange-h' || kind === 'arrange-v' || kind === 'arrange-grid') {
      // Rows of overlapping cards, each row left to right, as Obsidian arranges them.
      const sorted = [...nodes].sort((p, q) => p.y - q.y)
      const rows = []
      let rowBottom = -Infinity
      for (const n of sorted) {
        if (n.y < rowBottom) {
          rows[rows.length - 1].push(n)
          rowBottom = Math.min(rowBottom, n.y + n.height)
        } else {
          rows.push([n])
          rowBottom = n.y + n.height
        }
      }
      for (const row of rows) row.sort((p, q) => p.x - q.x)
      const flat = rows.flat()
      if (kind === 'arrange-h') for (let i = 1; i < flat.length; i++) (flat[i].x = flat[i - 1].x + flat[i - 1].width + G), (flat[i].y = flat[0].y)
      else if (kind === 'arrange-v') for (let i = 1; i < flat.length; i++) (flat[i].y = flat[i - 1].y + flat[i - 1].height + G), (flat[i].x = flat[0].x)
      else {
        let y = b.y
        for (const row of rows) {
          row[0].x = b.x
          row[0].y = y
          let h = row[0].height
          for (let i = 1; i < row.length; i++) {
            row[i].x = row[i - 1].x + row[i - 1].width + G
            row[i].y = y
            h = Math.max(h, row[i].height)
          }
          y += h + G
        }
      }
    }
  }
  sync()
  commit()
}

function alignMenu(anchor) {
  const many = alignTargets()[0].length > 1
  showMenu(
    [
      { section: 'h', title: 'Align left', icon: 'align-left', onClick: () => align('left') },
      { section: 'h', title: 'Align center', icon: 'align-center', onClick: () => align('center') },
      { section: 'h', title: 'Align right', icon: 'align-right', onClick: () => align('right') },
      { section: 'v', title: 'Align top', icon: 'align-top', onClick: () => align('top') },
      { section: 'v', title: 'Align middle', icon: 'align-middle', onClick: () => align('middle') },
      { section: 'v', title: 'Align bottom', icon: 'align-bottom', onClick: () => align('bottom') },
      many && { section: 'd', title: 'Distribute horizontally', icon: 'distribute-h', onClick: () => align('distribute-h') },
      many && { section: 'd', title: 'Distribute vertically', icon: 'distribute-v', onClick: () => align('distribute-v') },
      many && { section: 's', title: 'Stretch horizontally', icon: 'stretch-h', onClick: () => align('stretch-h') },
      many && { section: 's', title: 'Stretch vertically', icon: 'stretch-v', onClick: () => align('stretch-v') },
      many && { section: 'a', title: 'Arrange horizontally', icon: 'distribute-h', onClick: () => align('arrange-h') },
      many && { section: 'a', title: 'Arrange vertically', icon: 'distribute-v', onClick: () => align('arrange-v') },
      many && { section: 'a', title: 'Arrange in grid', icon: 'grid', onClick: () => align('arrange-grid') }
    ],
    { anchor: anchor.getBoundingClientRect() }
  )
}

function directionIcon(edges) {
  const last = edges[edges.length - 1]
  if ((last.fromEnd ?? 'none') === 'arrow') return 'move-horizontal'
  if ((last.toEnd ?? 'arrow') === 'none') return 'line'
  return 'arrow-right'
}

function setDirection(edges, fromEnd, toEnd) {
  for (const e of edges) {
    e.fromEnd = fromEnd
    e.toEnd = toEnd
    if (fromEnd === 'none') delete e.fromEnd
    if (toEnd === 'arrow') delete e.toEnd
  }
  sync()
  commit()
}

function directionMenu(anchor, edges) {
  const cur = directionIcon(edges)
  showMenu(
    [
      { title: 'Nondirectional', icon: 'line', checked: cur === 'line', onClick: () => setDirection(edges, 'none', 'none') },
      { title: 'Unidirectional', icon: 'arrow-right', checked: cur === 'arrow-right', onClick: () => setDirection(edges, 'none', 'arrow') },
      { title: 'Bidirectional', icon: 'move-horizontal', checked: cur === 'move-horizontal', onClick: () => setDirection(edges, 'arrow', 'arrow') }
    ],
    { anchor: anchor.getBoundingClientRect() }
  )
}

function backgroundMenu(anchor, group) {
  const pick = () =>
    pickFile('media', (file) => {
      group.background = file
      sync()
      commit()
    })
  if (!group.background) return pick()
  const setStyle = (s) => {
    if (s === 'cover') delete group.backgroundStyle
    else group.backgroundStyle = s
    sync()
    commit()
  }
  showMenu(
    [
      { section: 'i', title: 'Replace background', icon: 'image', onClick: pick },
      {
        section: 'i',
        title: 'Remove background',
        icon: 'image-off',
        onClick: () => {
          delete group.background
          delete group.backgroundStyle
          sync()
          commit()
        }
      },
      { section: 's', title: 'Cover', checked: !group.backgroundStyle || group.backgroundStyle === 'cover', onClick: () => setStyle('cover') },
      { section: 's', title: 'Keep aspect ratio', checked: group.backgroundStyle === 'ratio', onClick: () => setStyle('ratio') },
      { section: 's', title: 'Repeat', checked: group.backgroundStyle === 'repeat', onClick: () => setStyle('repeat') }
    ],
    { anchor: anchor.getBoundingClientRect() }
  )
}

function renderSelectionMenu() {
  const size = selectionSize()
  if (!size || draggingNow || state.editing?.kind === 'text-inline') {
    menuContainer.style.display = 'none'
    if (!size) {
      menuEl.replaceChildren()
      submenu = null
    }
    return
  }
  menuContainer.style.display = ''
  if (menuDirty) {
    menuDirty = false
    menuEl.replaceChildren()
    submenu = null
    const items = selectedItems()
    const single = size === 1
    const last = items[items.length - 1]
    const nodes = [...state.selNodes].map(nodeById).filter(Boolean)
    const edges = [...state.selEdges].map(edgeById).filter(Boolean)
    if (isEditable()) {
      menuButton('Remove', 'trash', deleteSelection)
      menuButton('Set color', 'palette', (e) => colorSubmenu(e.currentTarget, items))
    }
    menuButton('Zoom to selection (Shift+2)', 'zoom-selection', zoomToSelection)
    if (isEditable()) {
      if (!single && nodes.length) menuButton('Create group', 'group', () => createGroupFromSelection())
      if ((!single && nodes.length > 1) || (single && last.type === 'group')) menuButton('Align', 'align-left', (e) => alignMenu(e.currentTarget))
      if (edges.length && edges.length === items.length) menuButton('Line direction', directionIcon(edges), (e) => directionMenu(e.currentTarget, edges))
      if (single && edges.length && last.label) {
        menuButton('Remove label', 'x-square', () => {
          delete last.label
          sync()
          commit()
        })
      }
      if (single && edges.length) menuButton('Edit label', 'edit', () => startEdgeLabelEdit(last.id))
      else if (single && last.type === 'text') menuButton('Edit', 'edit', () => startEditing(last.id))
      else if (single && last.type === 'group') {
        menuButton('Edit label', 'edit', () => startGroupLabelEdit(last.id))
        menuButton(last.background ? 'Edit background' : 'Set background', 'image', (e) => backgroundMenu(e.currentTarget, last))
      } else if (single && last.type === 'file' && extname(last.file) === 'md' && !last.subpath) menuButton('Edit', 'edit', () => startEditing(last.id))
    }
  }
  positionSelectionMenu()
}

function positionSelectionMenu() {
  if (menuContainer.style.display === 'none' || !selectionSize()) return
  const box = bounds(selectionBoxes())
  if (!box) return
  const top = toScreen(box.x + box.width / 2, box.y)
  const w = menuEl.offsetWidth
  const h = menuEl.offsetHeight
  const W = wrapper.clientWidth
  const H = wrapper.clientHeight
  const left = clamp(top.x - w / 2, 10, W - w - 10)
  const y = clamp(top.y - h - 20, 10, H - h - 10)
  menuContainer.style.left = `${left}px`
  menuContainer.style.top = `${y}px`
}

// ---- Creating and changing cards ---------------------------------------------------------------

function snapValue(v) {
  if (!state.options.snapToGrid) return v
  const G = gridSpacing(state.view.zoom)
  return Math.round(v / G) * G
}

// Obsidian's placement: `pos` is the card's top-left, its centre, or the middle of one side.
function placeBox(pos, size, position) {
  let x = pos.x
  let y = pos.y
  if (position === 'center') (x -= size.width / 2), (y -= size.height / 2)
  else if (position === 'left') y -= size.height / 2
  else if (position === 'top') x -= size.width / 2
  else if (position === 'right') (x -= size.width), (y -= size.height / 2)
  else if (position === 'bottom') (x -= size.width / 2), (y -= size.height)
  return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height }
}

function addNode(node, { select = true } = {}) {
  state.data.nodes.push(node)
  sync()
  if (select) selectOnly(node.id)
  commit()
  return node
}

function createTextNode(pos, { position, size = TEXT_SIZE, text = '', edit = true } = {}) {
  if (!isEditable()) return null
  const b = placeBox(pos, size, position)
  const node = addNode({ id: newId(), type: 'text', text, x: b.x, y: b.y, width: b.width, height: b.height })
  if (edit) {
    if (!text) state.justCreated.add(node.id)
    startEditing(node.id)
  }
  return node
}

function createFileNode(pos, file, { position, size = FILE_SIZE } = {}) {
  if (!isEditable()) return null
  const b = placeBox(pos, size, position)
  const node = { id: newId(), type: 'file', file, x: b.x, y: b.y, width: b.width, height: b.height }
  if (isMediaKind(EXT_KIND[extname(file)])) state.autosize.add(node.id)
  return addNode(node)
}

function createLinkNode(pos, url, { position, size = FILE_SIZE } = {}) {
  if (!isEditable()) return null
  const b = placeBox(pos, size, position)
  return addNode({ id: newId(), type: 'link', url, x: b.x, y: b.y, width: b.width, height: b.height })
}

function createGroupNode(box, { edit = true } = {}) {
  if (!isEditable()) return null
  const node = { id: newId(), type: 'group', x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
  addNode(node)
  if (edit) startGroupLabelEdit(node.id)
  return node
}

function createGroupFromSelection() {
  const b = bounds([...state.selNodes].map(nodeById).filter(Boolean).map(nodeBox))
  if (!b) return
  createGroupNode({ x: b.x - 20, y: b.y - 20, width: b.width + 40, height: b.height + 40 })
}

function pickFile(kind, onChoose) {
  const isMedia = (f) => isMediaKind(EXT_KIND[extname(f)])
  const filter =
    kind === 'note'
      ? (f) => extname(f) === 'md' || extname(f) === 'canvas' || extname(f) === 'base'
      : kind === 'media'
        ? isMedia
        : () => true
  openSuggester({
    placeholder: kind === 'note' ? 'Find or create a note...' : 'Find a file...',
    load: async () => (await vaultFiles(true)).filter(filter),
    render: (f) => ({ title: extname(f) === 'md' ? stem(f) : basename(f), note: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '' }),
    onChoose
  })
}

function addNoteAt(pos, opts = {}, after) {
  pickFile('note', (file) => {
    const n = createFileNode(pos, file, opts)
    after?.(n)
  })
}

function addMediaAt(pos, opts = {}, after) {
  pickFile('media', (file) => {
    const n = createFileNode(pos, file, opts)
    after?.(n)
  })
}

function addLinkAt(pos, opts = {}, after) {
  openPrompt({
    title: 'Enter URL',
    placeholder: 'https://',
    validate: (v) => {
      try {
        new URL(v)
      } catch {
        return 'Invalid URL'
      }
    },
    onSubmit: (url) => {
      const n = createLinkNode(pos, url, opts)
      after?.(n)
    }
  })
}

function creationMenuItems(pos, opts = {}, after) {
  return [
    {
      section: 'create',
      title: 'Add card',
      icon: 'sticky-note',
      onClick: () => {
        const n = createTextNode(pos, { ...opts, edit: false })
        if (!n) return
        after?.(n)
        state.justCreated.add(n.id)
        startEditing(n.id)
      }
    },
    { section: 'create', title: 'Add note from vault', icon: 'file-text', onClick: () => addNoteAt(pos, opts, after) },
    { section: 'create', title: 'Add media from vault', icon: 'file-image', onClick: () => addMediaAt(pos, opts, after) },
    { section: 'create', title: 'Add web page', icon: 'jc-link-external', onClick: () => addLinkAt(pos, opts, after) },
    { section: 'create', title: 'Create group', icon: 'group', onClick: () => after?.(createGroupNode(placeBox(pos, opts.size ?? FILE_SIZE, opts.position), { edit: !after })) }
  ]
}

function deleteSelection() {
  if (!isEditable()) return
  const nodes = state.selNodes
  const edges = state.selEdges
  if (!nodes.size && !edges.size) return
  state.data.nodes = state.data.nodes.filter((n) => !nodes.has(n.id))
  state.data.edges = state.data.edges.filter((e) => !edges.has(e.id) && !nodes.has(e.fromNode) && !nodes.has(e.toNode))
  state.selNodes = new Set()
  state.selEdges = new Set()
  sync()
  commit()
}

function bringToFront(ids) {
  const set = new Set(ids)
  const moving = state.data.nodes.filter((n) => set.has(n.id))
  if (!moving.length) return
  state.data.nodes = [...state.data.nodes.filter((n) => !set.has(n.id)), ...moving]
}

// Copies nodes (and the edges among them) with new ids, moved by (dx, dy).
function cloneItems(nodes, edges, dx, dy) {
  const ids = new Map()
  const newNodes = nodes.map((n) => {
    const copy = structuredClone(n)
    const id = newId()
    ids.set(n.id, id)
    copy.id = id
    copy.x = Math.round((Number(n.x) || 0) + dx)
    copy.y = Math.round((Number(n.y) || 0) + dy)
    return copy
  })
  const newEdges = edges
    .filter((e) => ids.has(e.fromNode) && ids.has(e.toNode))
    .map((e) => ({ ...structuredClone(e), id: newId(), fromNode: ids.get(e.fromNode), toNode: ids.get(e.toNode) }))
  return { nodes: newNodes, edges: newEdges }
}

function selectionData() {
  const nodes = state.data.nodes.filter((n) => state.selNodes.has(n.id))
  const ids = new Set(nodes.map((n) => n.id))
  const edges = state.data.edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode))
  return { nodes, edges }
}

function pasteData(data, at) {
  if (!isEditable()) return
  const box = bounds(data.nodes.map(nodeBox))
  if (!box) return
  const dx = snapValue(at.x - box.x)
  const dy = snapValue(at.y - box.y)
  const copy = cloneItems(data.nodes, data.edges ?? [], dx, dy)
  state.data.nodes.push(...copy.nodes)
  state.data.edges.push(...copy.edges)
  state.selNodes = new Set(copy.nodes.map((n) => n.id))
  state.selEdges = new Set()
  sync()
  commit()
}

function pasteText(text, at) {
  if (!isEditable()) return
  const t = text.trim()
  if (!t) return
  try {
    const data = JSON.parse(t)
    if (data && Array.isArray(data.nodes)) return pasteData(data, at)
  } catch {}
  if (/^https?:\/\/\S+$/.test(t)) return createLinkNode(at, t, { position: 'center' })
  createTextNode(at, { position: 'center', text: t, edit: false })
}

// ---- Editing -----------------------------------------------------------------------------------

let textEditorModule = null
const loadTextEditor = () => (textEditorModule ??= import('./text-editor.js'))
const linkFiles = () => vaultFiles().catch(() => [])

function stopEditing(save = true) {
  const editing = state.editing
  if (!editing) return
  state.editing = null
  editing.stop(save)
  menuDirty = true
  updateSelectionUI(true)
}

async function startEditing(id) {
  if (!isEditable()) return
  const n = nodeById(id)
  if (!n) return
  if (n.type === 'group') return startGroupLabelEdit(id)
  if (n.type === 'file') {
    if (extname(n.file) === 'md' && !n.subpath) return startNoteEdit(id)
    return openNodeFile(n)
  }
  if (n.type !== 'text') return
  if (state.editing?.id === id) return
  stopEditing(true)
  const entry = state.els.get(id)
  if (!entry) return
  const { createTextEditor } = await loadTextEditor()
  if (!nodeById(id)) return
  selectOnly(id)
  const node = entry.el
  const embedContent = node.querySelector('.jc-md-inner')
  if (!embedContent) return
  node.classList.add('is-editing')
  const source = el('div', 'jc-editor jc-editor-cm jc-editor-theme jc-editor-live')
  embedContent.replaceChildren(source)
  let typingTimer = 0
  let typed = false
  const flushTyping = () => {
    clearTimeout(typingTimer)
    if (!typed) return
    typed = false
    entry.json = JSON.stringify(n)
    commit()
  }
  const view = createTextEditor({
    parent: source,
    text: n.text ?? '',
    getFiles: linkFiles,
    onExit: () => stopEditing(true),
    onChange: (value) => {
      n.text = value
      typed = true
      state.justCreated.delete(id)
      clearTimeout(typingTimer)
      typingTimer = setTimeout(flushTyping, 500)
    }
  })
  view.focus()
  view.dispatch({ selection: { anchor: view.state.doc.length } })
  state.editing = {
    id,
    kind: 'text',
    el: node,
    flush: flushTyping,
    stop: (save) => {
      flushTyping()
      view.destroy()
      node.classList.remove('is-editing')
      const empty = !(n.text ?? '').trim()
      if (state.justCreated.has(id) && empty) {
        state.justCreated.delete(id)
        state.data.nodes = state.data.nodes.filter((x) => x.id !== id)
        state.selNodes.delete(id)
        sync()
        commit({ amend: true })
        return
      }
      state.justCreated.delete(id)
      // Re-render the card from its text.
      const e = state.els.get(id)
      if (e) (e.json = ''), (e.shape = '')
      sync()
      if (save) flushSave()
    }
  }
  updateSelectionUI(true)
}

// Inline editing of a note card writes the note itself, as Obsidian does.
async function startNoteEdit(id) {
  const n = nodeById(id)
  const entry = state.els.get(id)
  if (!n || !entry) return
  stopEditing(true)
  const vault = await ensureVault()
  const path = entry.el.dataset.resolved
  if (!vault || !path) return toast(`"${n.file}" could not be found.`)
  const [{ createTextEditor }, { text }] = await Promise.all([loadTextEditor(), call('canvas.text', { root: vault.root, path })])
  const [info] = await resolveItems([{ path }])
  let mtime = info?.mtime
  selectOnly(id)
  const node = entry.el
  const content = node.querySelector('.jc-card-body')
  if (!content) return
  node.classList.add('is-editing')
  const wrap = el('div', 'jc-card-body jc-md-host')
  const embedContent = el('div', 'jc-md-inner')
  const source = el('div', 'jc-editor jc-editor-cm jc-editor-theme jc-editor-live')
  embedContent.append(source)
  wrap.append(embedContent)
  content.replaceWith(wrap)
  let current = text
  let saved = text
  let timer = 0
  let writing = Promise.resolve()
  const write = () => {
    clearTimeout(timer)
    if (current === saved) return writing
    const value = current
    writing = writing.then(async () => {
      const token = newId()
      const size = 30000
      const parts = Math.max(1, Math.ceil(value.length / size))
      try {
        let result
        for (let i = 0; i < parts; i++)
          result = await call('canvas.writeText', { root: vault.root, path, token, part: i, parts, text: value.slice(i * size, (i + 1) * size), baseMtime: mtime })
        mtime = result?.mtime ?? mtime
        saved = value
      } catch (error) {
        toast(error?.code === 'conflict' ? `${basename(path)} changed on disk; your edit was not saved.` : `Couldn't save ${basename(path)}: ${error.message}`, 6000)
      }
    })
    return writing
  }
  const view = createTextEditor({
    parent: source,
    text,
    getFiles: linkFiles,
    onExit: () => stopEditing(true),
    onChange: (value) => {
      current = value
      clearTimeout(timer)
      timer = setTimeout(write, 600)
    }
  })
  view.focus()
  state.editing = {
    id,
    kind: 'note',
    el: node,
    flush: write,
    stop: () => {
      write().then(() => {
        const e = state.els.get(id)
        if (e) (e.json = ''), (e.shape = '')
        sync()
      })
      view.destroy()
      node.classList.remove('is-editing')
    }
  }
  updateSelectionUI(true)
}

function editableText(target, { initial, multiline = false, onDone }) {
  target.contentEditable = 'true'
  target.spellcheck = false
  target.textContent = initial
  target.focus()
  const range = document.createRange()
  range.selectNodeContents(target)
  const sel = getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  let done = false
  const finish = (save) => {
    if (done) return
    done = true
    target.removeEventListener('keydown', onKey)
    target.removeEventListener('blur', onBlur)
    target.contentEditable = 'false'
    onDone(save ? target.innerText.replace(/\n$/, '') : null)
  }
  const onKey = (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    } else if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
      e.preventDefault()
      finish(true)
    }
  }
  const onBlur = () => finish(true)
  target.addEventListener('keydown', onKey)
  target.addEventListener('blur', onBlur)
  return finish
}

function startGroupLabelEdit(id) {
  if (!isEditable()) return
  const n = nodeById(id)
  const entry = state.els.get(id)
  if (!n || !entry) return
  stopEditing(true)
  selectOnly(id)
  let label = entry.el.querySelector('.jc-group-title')
  if (!label) {
    label = el('div', 'jc-group-title')
    entry.el.append(label)
  }
  const finish = editableText(label, {
    initial: n.label ?? '',
    onDone: (value) => {
      state.editing = null
      if (value != null) {
        if (value.trim()) n.label = value.trim()
        else delete n.label
      }
      const e = state.els.get(id)
      if (e) (e.json = ''), (e.shape = '')
      sync()
      if (value != null) commit()
    }
  })
  state.editing = { id, kind: 'group-label', el: entry.el, stop: (save) => finish(save) }
}

function startEdgeLabelEdit(id) {
  if (!isEditable()) return
  const e = edgeById(id)
  const geo = e && edgeGeometry(e)
  if (!geo) return
  stopEditing(true)
  selectOnly(id, 'edge')
  editingEdgeId = id
  renderEdges()
  const wrap = el('div', 'jc-edge-label-anchor')
  wrap.style.transform = `translate(${geo.mid.x}px, ${geo.mid.y}px)`
  const label = el('div', 'jc-edge-label is-editing')
  applyColor(wrap, e.color)
  wrap.append(label)
  edgeLabelsEl.after(wrap)
  const finish = editableText(label, {
    initial: e.label ?? '',
    multiline: true,
    onDone: (value) => {
      state.editing = null
      editingEdgeId = null
      wrap.remove()
      if (value != null) {
        if (value.trim()) e.label = value
        else delete e.label
        commit()
      }
      renderEdges()
      menuDirty = true
      updateSelectionUI(true)
    }
  })
  state.editing = { id, kind: 'edge-label', el: wrap, stop: (save) => finish(save) }
}

// ---- Opening things ----------------------------------------------------------------------------

async function openExternal(url) {
  try {
    const result = orca.shell?.openExternal ? await orca.shell.openExternal(url) : await orca.host.call('shell.openExternal', { url })
    if (result && result.opened === false && result.reason !== 'cancelled') toast(`Couldn't open ${url}`)
  } catch (error) {
    toast(`Couldn't open ${url}: ${error.message || error.code}`)
  }
}

async function openVaultFile(path, subpath) {
  const vault = await ensureVault()
  if (!vault) return
  try {
    toast(`Opening ${basename(path)}${subpath ? ` › ${subpath.replace(/^#/, '')}` : ''}…`, 2000)
    await call('canvas.open', { root: vault.root, path, subpath: subpath || undefined })
  } catch (error) {
    toast(`Couldn't open ${basename(path)}: ${error.message || error.code}`)
  }
}

function openNodeFile(n) {
  const elx = state.els.get(n.id)?.el
  if (elx?.dataset.resolved) openVaultFile(elx.dataset.resolved, n.subpath)
  else toast(`"${n.file}" could not be found.`)
}

async function activateLink(a, sourcePath) {
  if (a.dataset.external) return openExternal(a.dataset.external)
  if (a.classList.contains('jc-tag')) return toast(`Tag search isn't available outside Obsidian (${a.textContent}).`)
  if (!a.classList.contains('jc-link-internal')) return
  const target = a.dataset.target
  const subpath = a.dataset.subpath || ''
  if (!target) {
    if (sourcePath) return openVaultFile(sourcePath, subpath)
    return
  }
  let path = a.dataset.resolved
  if (!path) {
    const [info] = await resolveItems([{ link: target, from: sourcePath ?? undefined }])
    path = info?.path
  }
  if (!path) return toast(`"${target}" doesn't exist in this vault yet.`)
  openVaultFile(path, subpath)
}

function sourcePathOf(nodeEl) {
  return nodeEl?.dataset.resolved && extname(nodeEl.dataset.resolved) === 'md' ? nodeEl.dataset.resolved : null
}

// ---- Hit testing -------------------------------------------------------------------------------

// Topmost card under a world point: cards above groups, smaller groups above larger.
function nodeAt(p, exclude) {
  const hit = (n) => {
    const b = nodeBox(n)
    return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
  }
  const cards = state.data.nodes.filter((n) => n.type !== 'group' && n.id !== exclude && hit(n))
  if (cards.length) return cards[cards.length - 1]
  const groups = state.data.nodes.filter((n) => n.type === 'group' && n.id !== exclude && hit(n))
  groups.sort((a, b) => nodeBox(a).width * nodeBox(a).height - nodeBox(b).width * nodeBox(b).height)
  return groups[0] ?? null
}

const isUiTarget = (t) => t.closest?.('.jc-controls, .jc-dock, .jc-toolbar-anchor, .jc-help, .jc-menu, .jc-modal-layer')

// ---- Snapping ----------------------------------------------------------------------------------

function snapLines(lines) {
  snapsSvg.replaceChildren()
  for (const l of lines) {
    const line = document.createElementNS(SVG_NS, 'line')
    line.setAttribute('x1', l.x1)
    line.setAttribute('y1', l.y1)
    line.setAttribute('x2', l.x2)
    line.setAttribute('y2', l.y2)
    snapsSvg.append(line)
  }
}

// Snaps a moving box to other cards' edges and centres, else to the grid.
function snapBox(box, exclude, axes = { x: true, y: true }) {
  let dx = 0
  let dy = 0
  const lines = []
  const threshold = SNAP_DISTANCE / scaleOf(state.view.zoom)
  let snappedX = false
  let snappedY = false
  if (state.options.snapToObjects) {
    const others = state.data.nodes.filter((n) => !exclude.has(n.id)).map(nodeBox)
    const xs = [box.x, box.x + box.width / 2, box.x + box.width]
    const ys = [box.y, box.y + box.height / 2, box.y + box.height]
    let bestX = null
    let bestY = null
    for (const o of others) {
      for (const tx of [o.x, o.x + o.width / 2, o.x + o.width])
        for (const sx of xs) {
          const d = tx - sx
          if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, t: tx, o }
        }
      for (const ty of [o.y, o.y + o.height / 2, o.y + o.height])
        for (const sy of ys) {
          const d = ty - sy
          if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, t: ty, o }
        }
    }
    if (bestX && axes.x) {
      dx = bestX.d
      snappedX = true
      const y1 = Math.min(box.y, bestX.o.y)
      const y2 = Math.max(box.y + box.height, bestX.o.y + bestX.o.height)
      lines.push({ x1: bestX.t, y1, x2: bestX.t, y2 })
    }
    if (bestY && axes.y) {
      dy = bestY.d
      snappedY = true
      const x1 = Math.min(box.x, bestY.o.x)
      const x2 = Math.max(box.x + box.width, bestY.o.x + bestY.o.width)
      lines.push({ x1, y1: bestY.t, x2, y2: bestY.t })
    }
  }
  if (state.options.snapToGrid) {
    if (!snappedX && axes.x) dx = snapValue(box.x) - box.x
    if (!snappedY && axes.y) dy = snapValue(box.y) - box.y
  }
  snapLines(lines)
  return { dx, dy }
}

// ---- Input -------------------------------------------------------------------------------------

let spaceHeld = false
let drag = null

function canScroll(scroller, dy) {
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 1) return false
  if (dy < 0) return scroller.scrollTop > 0
  return scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1
}

wrapper.addEventListener(
  'wheel',
  (e) => {
    if (drag?.moved && drag.kind === 'pan') return
    if (isUiTarget(e.target)) return
    const zooming = e.ctrlKey || e.metaKey || spaceHeld
    if (!zooming) {
      const nodeEl = e.target.closest?.('.jc-card')
      if (nodeEl && (nodeEl.classList.contains('is-focused') || nodeEl.classList.contains('is-editing'))) {
        const scroller = e.target.closest('.jc-md-scroll, .cm-scroller, .jc-card-body')
        if (canScroll(scroller, e.deltaY)) return
      }
    }
    e.preventDefault()
    let dx = e.deltaX
    let dy = e.deltaY
    if (e.deltaMode === 1) (dx *= 40), (dy *= 40)
    else if (e.deltaMode === 2) (dx *= 800), (dy *= 800)
    const s = scaleOf(state.view.zoom)
    if (zooming) {
      let center
      if (dy < 0) {
        const rect = wrapper.getBoundingClientRect()
        center = { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 }
      }
      zoomBy(-dy / 300, center)
    } else if (e.shiftKey && dx === 0) {
      state.target.x += (dy / s) * WHEEL_PAN
      requestTick()
    } else {
      state.target.x += (dx / s) * WHEEL_PAN
      state.target.y += (dy / s) * WHEEL_PAN
      requestTick()
    }
  },
  { passive: false }
)

function beginDrag(e, props) {
  state.target = { ...state.view, center: null }
  drag = { startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, pointerId: e.pointerId, target: e.target, ...props }
}

wrapper.addEventListener('pointerdown', (e) => {
  if (isUiTarget(e.target)) return
  closeMenu()
  helpEl.classList.remove('is-open')
  state.pointer = toWorld(e.clientX, e.clientY)

  // Inside what is being edited: the editor handles it.
  if (state.editing && state.editing.el.contains(e.target) && !e.target.closest('.jc-handle')) return
  if (state.editing) stopEditing(true)
  if (!e.target.closest('input, textarea')) wrapper.focus({ preventScroll: true })

  const nodeEl = e.target.closest('.jc-card')
  const id = nodeEl?.dataset.id
  const pan = e.button === 1 || (e.button === 0 && spaceHeld)
  if (pan) {
    e.preventDefault()
    return beginDrag(e, { kind: 'pan' })
  }
  if (e.button !== 0) return

  // Media controls keep their own pointer handling.
  if (nodeEl?.classList.contains('is-focused') && e.target.closest('video, audio')) return

  if (!isEditable()) {
    if (nodeEl?.classList.contains('is-focused') && e.target.closest('.jc-md-scroll, .jc-card-placeholder.is-link')) return
    return beginDrag(e, { kind: 'pan', clickNode: id ?? null, clickEdge: e.target.closest?.('.jc-edges g[data-id]')?.dataset.id ?? null })
  }

  // Connection point: draw a new edge.
  const cp = e.target.closest('.jc-port')
  if (cp && id) {
    const n = nodeById(id)
    return beginDrag(e, { kind: 'connect', fromId: id, fromSide: cp.dataset.side, A: sideAnchor(nodeBox(n), cp.dataset.side) })
  }

  // Resize handle.
  const resizer = e.target.closest('.jc-handle')
  if (resizer && id) {
    if (!state.selNodes.has(id) || selectionSize() !== 1) selectOnly(id)
    const n = nodeById(id)
    return beginDrag(e, { kind: 'resize', id, dir: resizer.dataset.resize, start: nodeBox(n) })
  }

  // Box around a multi-selection: drag them all.
  if (e.target === groupSelectionEl) return beginDrag(e, { kind: 'move', ids: [...state.selNodes] })

  // Edge: select, or drag one end to reconnect it.
  const edgeG = e.target.closest?.('.jc-edges g[data-id]')
  if (edgeG) {
    const eid = edgeG.dataset.id
    const edge = edgeById(eid)
    const geo = edge && edgeGeometry(edge)
    if (e.shiftKey) return toggleSelect(eid, 'edge')
    if (geo && state.selEdges.has(eid)) {
      const p = state.pointer
      const near = 30 / scaleOf(state.view.zoom)
      const end = Math.hypot(p.x - geo.L.x, p.y - geo.L.y) < near ? 'to' : Math.hypot(p.x - geo.A.x, p.y - geo.A.y) < near ? 'from' : null
      if (end) return beginDrag(e, { kind: 'reconnect', edgeId: eid, end })
    }
    if (!state.selEdges.has(eid) || selectionSize() !== 1) selectOnly(eid, 'edge')
    return
  }

  if (id) {
    if (e.shiftKey) return toggleSelect(id)
    if (!state.selNodes.has(id)) selectOnly(id)
    return beginDrag(e, { kind: 'move', ids: [...state.selNodes], duplicate: e.altKey })
  }

  // Empty canvas: box selection.
  beginDrag(e, { kind: 'box', origin: state.pointer, additive: e.shiftKey, initial: new Set(state.selNodes) })
})

function startMove(d) {
  let ids = d.ids
  if (d.duplicate) {
    const data = selectionData()
    const copy = cloneItems(data.nodes, data.edges, 0, 0)
    state.data.nodes.push(...copy.nodes)
    state.data.edges.push(...copy.edges)
    ids = copy.nodes.map((n) => n.id)
    state.selNodes = new Set(ids)
    state.selEdges = new Set()
  }
  // Groups carry the cards inside them.
  const moving = new Set(ids)
  for (const id of ids) {
    const n = nodeById(id)
    if (n?.type === 'group') for (const c of containedNodes(n)) moving.add(c.id)
  }
  const nonGroups = ids.filter((id) => nodeById(id)?.type !== 'group')
  if (!d.duplicate) bringToFront(nonGroups)
  d.moving = [...moving].map(nodeById).filter(Boolean)
  d.starts = new Map(d.moving.map((n) => [n.id, { x: Number(n.x) || 0, y: Number(n.y) || 0 }]))
  d.startBox = bounds(ids.map(nodeById).filter(Boolean).map(nodeBox))
  d.exclude = moving
  sync()
}

window.addEventListener('pointermove', (e) => {
  state.pointer = toWorld(e.clientX, e.clientY)
  if (!drag || e.pointerId !== drag.pointerId) return
  if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return
  const d = drag
  if (!d.moved) {
    d.moved = true
    if (d.kind === 'pan' || d.kind === 'move') wrapper.classList.add('is-dragging')
    try {
      wrapper.setPointerCapture(e.pointerId)
    } catch {}
    if (d.kind === 'move' || d.kind === 'box') {
      if (d.kind === 'move') startMove(d)
      draggingNow = true
      renderSelectionMenu()
    }
  }
  const s = scaleOf(state.view.zoom)
  const wx = (e.clientX - d.startX) / s
  const wy = (e.clientY - d.startY) / s

  if (d.kind === 'pan') {
    panBy(e.clientX - d.lastX, e.clientY - d.lastY)
  } else if (d.kind === 'move') {
    const target = { ...d.startBox, x: d.startBox.x + wx, y: d.startBox.y + wy }
    const { dx, dy } = e.altKey && !d.duplicate ? { dx: 0, dy: 0 } : snapBox(target, d.exclude)
    for (const n of d.moving) {
      const st = d.starts.get(n.id)
      n.x = Math.round(st.x + wx + dx)
      n.y = Math.round(st.y + wy + dy)
      setGeometry(state.els.get(n.id).el, n)
    }
    renderEdges()
    updateSelectionUI()
  } else if (d.kind === 'resize') {
    const n = nodeById(d.id)
    const st = d.start
    let { x, y, width, height } = st
    const dir = d.dir
    if (dir.includes('right')) width = st.width + wx
    if (dir.includes('left')) (x = st.x + wx), (width = st.width - wx)
    if (dir.includes('bottom')) height = st.height + wy
    if (dir.includes('top')) (y = st.y + wy), (height = st.height - wy)
    if (e.shiftKey && dir.length > 6) {
      // Corner + Shift keeps the aspect ratio.
      const ratio = st.width / st.height
      if (width / height > ratio) height = width / ratio
      else width = height * ratio
      if (dir.includes('left')) x = st.x + st.width - width
      if (dir.includes('top')) y = st.y + st.height - height
    } else if (state.options.snapToGrid) {
      if (dir.includes('right')) width = snapValue(x + width) - x
      if (dir.includes('left')) {
        const nx = snapValue(x)
        width += x - nx
        x = nx
      }
      if (dir.includes('bottom')) height = snapValue(y + height) - y
      if (dir.includes('top')) {
        const ny = snapValue(y)
        height += y - ny
        y = ny
      }
    }
    if (width < MIN_SIZE) {
      if (dir.includes('left')) x -= MIN_SIZE - width
      width = MIN_SIZE
    }
    if (height < MIN_SIZE) {
      if (dir.includes('top')) y -= MIN_SIZE - height
      height = MIN_SIZE
    }
    Object.assign(n, { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) })
    setGeometry(state.els.get(n.id).el, n)
    renderEdges()
    updateSelectionUI()
  } else if (d.kind === 'connect' || d.kind === 'reconnect') {
    const p = state.pointer
    let A
    let fromSide
    let fixedId
    if (d.kind === 'connect') {
      A = d.A
      fromSide = d.fromSide
      fixedId = d.fromId
    } else {
      const edge = edgeById(d.edgeId)
      const geo = edge && edgeGeometry(edge)
      if (!geo) return
      if (d.end === 'to') (A = geo.A), (fromSide = geo.fromSide), (fixedId = edge.fromNode)
      else (A = geo.L), (fromSide = geo.toSide), (fixedId = edge.toNode)
    }
    const over = nodeAt(p, fixedId)
    if (over) {
      const side = nearestSide(nodeBox(over), p)
      tempEdge = { A, fromSide, L: sideAnchor(nodeBox(over), side), toSide: side }
      d.drop = { id: over.id, side }
    } else {
      const toSide = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' }[facingSideForPoint(A, p)]
      tempEdge = { A, fromSide, L: p, toSide }
      d.drop = null
    }
    if (d.kind === 'reconnect') edgeById(d.edgeId)._hidden = true
    renderEdgesWithHidden()
  } else if (d.kind === 'box') {
    const o = d.origin
    const p = state.pointer
    const rect = { x: Math.min(o.x, p.x), y: Math.min(o.y, p.y), width: Math.abs(p.x - o.x), height: Math.abs(p.y - o.y) }
    boxSelectionEl.style.display = 'block'
    boxSelectionEl.style.transform = `translate(${rect.x}px, ${rect.y}px)`
    boxSelectionEl.style.width = `${rect.width}px`
    boxSelectionEl.style.height = `${rect.height}px`
    const hits = new Set(d.additive ? d.initial : [])
    for (const n of state.data.nodes) {
      const b = nodeBox(n)
      const inter = b.x < rect.x + rect.width && b.x + b.width > rect.x && b.y < rect.y + rect.height && b.y + b.height > rect.y
      const inside = b.x >= rect.x && b.y >= rect.y && b.x + b.width <= rect.x + rect.width && b.y + b.height <= rect.y + rect.height
      if (n.type === 'group' ? inside : inter) hits.add(n.id)
    }
    state.selNodes = hits
    state.selEdges = new Set()
    updateSelectionUI(true)
  }
  d.lastX = e.clientX
  d.lastY = e.clientY
})

function facingSideForPoint(A, p) {
  const dx = p.x - A.x
  const dy = p.y - A.y
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left'
  return dy > 0 ? 'bottom' : 'top'
}

function renderEdgesWithHidden() {
  const hidden = state.data.edges.filter((e) => e._hidden)
  if (hidden.length) {
    const keep = state.data.edges
    state.data.edges = keep.filter((e) => !e._hidden)
    renderEdges()
    state.data.edges = keep
  } else renderEdges()
}

window.addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return
  const d = drag
  drag = null
  draggingNow = false
  wrapper.classList.remove('is-dragging')
  snapLines([])
  boxSelectionEl.style.display = 'none'

  if (!d.moved) {
    if (d.kind === 'pan') {
      // Read-only clicks select, as in edit mode.
      if (d.clickNode) selectOnly(d.clickNode)
      else if (d.clickEdge) selectOnly(d.clickEdge, 'edge')
      else deselectAll()
    } else if (d.kind === 'box' && !d.additive) deselectAll()
    else if (d.kind === 'move' && !e.shiftKey) {
      const nodeEl = d.target.closest?.('.jc-card')
      if (nodeEl && selectionSize() > 1 && !d.target.closest('.jc-marquee')) selectOnly(nodeEl.dataset.id)
    }
    renderSelectionMenu()
    return
  }

  if (d.kind === 'move' || d.kind === 'resize') {
    sync()
    commit()
  } else if (d.kind === 'connect') {
    tempEdge = null
    if (d.drop) {
      connect(d.fromId, d.fromSide, d.drop.id, d.drop.side)
    } else {
      renderEdges()
      // Dropped on empty canvas: Obsidian offers to create a card there, connected.
      const p = state.pointer
      const position = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' }[facingSideForPoint(d.A, p)]
      showMenu(
        creationMenuItems(p, { position }, (n) => {
          if (n) connect(d.fromId, d.fromSide, n.id, position)
        }),
        { x: e.clientX, y: e.clientY }
      )
    }
  } else if (d.kind === 'reconnect') {
    tempEdge = null
    const edge = edgeById(d.edgeId)
    if (edge) {
      delete edge._hidden
      if (d.drop) {
        if (d.end === 'to') (edge.toNode = d.drop.id), (edge.toSide = d.drop.side)
        else (edge.fromNode = d.drop.id), (edge.fromSide = d.drop.side)
        commit()
      }
    }
    sync()
  } else if (d.kind === 'box') {
    updateSelectionUI(true)
  }
  renderSelectionMenu()
})

function connect(fromId, fromSide, toId, toSide) {
  if (!isEditable() || fromId === toId) return
  const edge = { id: newId(), fromNode: fromId, fromSide, toNode: toId, toSide }
  state.data.edges.push(edge)
  sync()
  selectOnly(edge.id, 'edge')
  commit()
}

wrapper.addEventListener('click', (e) => {
  // Links in a focused card's content open (its blocker is hidden once it is focused).
  const a = e.target.closest('a, [data-external]')
  const nodeEl = e.target.closest('.jc-card.is-focused')
  if (a && nodeEl && !nodeEl.classList.contains('is-editing') && !e.target.closest('.jc-card-shield')) {
    e.preventDefault()
    activateLink(a, sourcePathOf(nodeEl))
  }
})

wrapper.addEventListener('dblclick', (e) => {
  if (isUiTarget(e.target)) return
  if (state.editing && state.editing.el.contains(e.target)) return
  const p = toWorld(e.clientX, e.clientY)
  const edgeG = e.target.closest?.('.jc-edges g[data-id]')
  const edgeLabel = e.target.closest?.('.jc-edge-label-anchor[data-id]')
  if (edgeG || edgeLabel) {
    const id = (edgeG || edgeLabel).dataset.id
    if (isEditable()) startEdgeLabelEdit(id)
    return
  }
  const nodeEl = e.target.closest('.jc-card')
  if (!nodeEl) {
    if (isEditable() && !e.target.closest('.jc-marquee')) createTextNode(p, { position: 'center' })
    return
  }
  const n = nodeById(nodeEl.dataset.id)
  if (!n) return
  if (e.target.closest('.jc-group-title')) {
    if (isEditable()) startGroupLabelEdit(n.id)
    else zoomToBbox(nodeBox(n))
    return
  }
  if (e.target.closest('.jc-card-caption') && n.type === 'file') return openNodeFile(n)
  if (n.type === 'text') {
    if (isEditable()) startEditing(n.id)
    else if (state.view.zoom < ZOOM_BREAKPOINT + 0.1) zoomToBbox(nodeBox(n))
    return
  }
  if (n.type === 'file') {
    if (isEditable() && extname(n.file) === 'md' && !n.subpath) return startNoteEdit(n.id)
    return openNodeFile(n)
  }
  if (n.type === 'link' && n.url) return openExternal(n.url)
  if (n.type === 'group') zoomToBbox(nodeBox(n))
})

wrapper.addEventListener('contextmenu', (e) => {
  if (isUiTarget(e.target)) return
  if (state.editing && state.editing.el.contains(e.target)) return
  e.preventDefault()
  const p = toWorld(e.clientX, e.clientY)
  const at = { x: e.clientX, y: e.clientY }
  const nodeEl = e.target.closest('.jc-card')
  const edgeG = e.target.closest?.('.jc-edges g[data-id]')
  const ro = !isEditable()
  if (edgeG) {
    const id = edgeG.dataset.id
    if (!state.selEdges.has(id)) selectOnly(id, 'edge')
    const edges = [...state.selEdges].map(edgeById).filter(Boolean)
    return showMenu(
      [
        !ro && edges.length === 1 && { section: 'edit', title: 'Edit label', icon: 'edit', onClick: () => startEdgeLabelEdit(id) },
        !ro && { section: 'dir', title: 'Nondirectional', icon: 'line', onClick: () => setDirection(edges, 'none', 'none') },
        !ro && { section: 'dir', title: 'Unidirectional', icon: 'arrow-right', onClick: () => setDirection(edges, 'none', 'arrow') },
        !ro && { section: 'dir', title: 'Bidirectional', icon: 'move-horizontal', onClick: () => setDirection(edges, 'arrow', 'arrow') },
        { section: 'view', title: 'Zoom to selection', icon: 'zoom-selection', onClick: zoomToSelection },
        !ro && { section: 'danger', title: 'Remove', icon: 'trash', warning: true, onClick: deleteSelection }
      ],
      at
    )
  }
  if (nodeEl) {
    const id = nodeEl.dataset.id
    if (!state.selNodes.has(id)) selectOnly(id)
    const n = nodeById(id)
    const single = selectionSize() === 1
    return showMenu(
      [
        !ro && single && (n.type === 'text' || (n.type === 'file' && extname(n.file) === 'md' && !n.subpath)) && { section: 'edit', title: 'Edit', icon: 'edit', onClick: () => startEditing(id) },
        !ro && single && n.type === 'group' && { section: 'edit', title: 'Edit label', icon: 'edit', onClick: () => startGroupLabelEdit(id) },
        single && n.type === 'file' && { section: 'open', title: 'Open in Orca', icon: 'jc-link-external', onClick: () => openNodeFile(n) },
        single && n.type === 'link' && { section: 'open', title: 'Open in browser', icon: 'jc-link-external', onClick: () => openExternal(n.url) },
        { section: 'clip', title: 'Copy', icon: 'copy', onClick: () => copySelection() },
        !ro && { section: 'clip', title: 'Cut', icon: 'scissors', onClick: () => copySelection(true) },
        !ro && { section: 'clip', title: 'Duplicate', icon: 'copy', onClick: duplicateSelection },
        !ro && !single && { section: 'group', title: 'Create group', icon: 'group', onClick: createGroupFromSelection },
        !ro && { section: 'order', title: 'Bring to front', icon: 'bring-front', onClick: () => (bringToFront([...state.selNodes]), sync(), commit()) },
        { section: 'view', title: 'Zoom to selection', icon: 'zoom-selection', onClick: zoomToSelection },
        !ro && { section: 'danger', title: 'Remove', icon: 'trash', warning: true, onClick: deleteSelection }
      ],
      at
    )
  }
  deselectAll()
  if (ro) return showMenu([{ title: 'Zoom to fit', icon: 'fit', onClick: () => zoomToFit() }], at)
  showMenu(
    [
      ...creationMenuItems(p, {}),
      state.history.canUndo && { section: 'history', title: 'Undo', icon: 'undo', onClick: undo },
      state.history.canRedo && { section: 'history', title: 'Redo', icon: 'redo', onClick: redo },
      { section: 'clip', title: 'Paste', icon: 'paste', onClick: () => pasteFromClipboard(p) },
      { section: 'select', title: 'Select all', onClick: selectAll }
    ],
    at
  )
})

// ---- Clipboard ---------------------------------------------------------------------------------

let localClipboard = null

function copySelection(cut = false) {
  const data = selectionData()
  if (!data.nodes.length) return
  localClipboard = JSON.stringify(data)
  try {
    navigator.clipboard?.writeText(localClipboard).catch(() => {})
  } catch {}
  if (cut) deleteSelection()
}

async function pasteFromClipboard(at) {
  let text = null
  try {
    text = await navigator.clipboard.readText()
  } catch {}
  text ??= localClipboard
  if (text) pasteText(text, at)
  else toast('Press Ctrl+V to paste.')
}

function duplicateSelection() {
  const data = selectionData()
  if (!data.nodes.length) return
  const box = bounds(data.nodes.map(nodeBox))
  pasteData(data, { x: box.x + box.width + 40, y: box.y })
}

const editingTarget = (t) => t.closest?.('.cm-editor, [contenteditable="true"], input, textarea')

document.addEventListener('copy', (e) => {
  if (editingTarget(e.target) || !state.selNodes.size) return
  const data = selectionData()
  localClipboard = JSON.stringify(data)
  e.clipboardData.setData('text/plain', localClipboard)
  e.preventDefault()
})
document.addEventListener('cut', (e) => {
  if (editingTarget(e.target) || !state.selNodes.size || !isEditable()) return
  const data = selectionData()
  localClipboard = JSON.stringify(data)
  e.clipboardData.setData('text/plain', localClipboard)
  e.preventDefault()
  deleteSelection()
})
document.addEventListener('paste', (e) => {
  if (editingTarget(e.target) || !isEditable()) return
  const text = e.clipboardData?.getData('text/plain') || localClipboard
  if (!text) return
  e.preventDefault()
  pasteText(text, state.pointer)
})

// ---- Keyboard ----------------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (isModalOpen() || isMenuOpen()) return
  if (editingTarget(e.target)) return
  if (e.code === 'Space' && !e.repeat) {
    spaceHeld = true
    wrapper.classList.add('is-space-held')
    e.preventDefault()
    return
  }
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  if (e.shiftKey && !mod && e.code === 'Digit1') return (e.preventDefault(), zoomToFit())
  if (e.shiftKey && !mod && e.code === 'Digit2') return (e.preventDefault(), zoomToSelection())
  if (mod && (e.key === '=' || e.key === '+')) return (e.preventDefault(), zoomBy(ZOOM_STEP))
  if (mod && e.key === '-') return (e.preventDefault(), zoomBy(-ZOOM_STEP))
  if (mod && e.key === '0') return (e.preventDefault(), zoomBy(-state.view.zoom))
  if (mod && key === 'a') return (e.preventDefault(), selectAll())
  if (mod && key === 'z' && !e.shiftKey) return (e.preventDefault(), undo())
  if (mod && ((key === 'z' && e.shiftKey) || key === 'y')) return (e.preventDefault(), redo())
  if (e.key === 'Escape') {
    helpEl.classList.remove('is-open')
    deselectAll()
    return
  }
  if (!isEditable()) return
  if (e.key === 'Delete' || e.key === 'Backspace') return (e.preventDefault(), deleteSelection())
  if (e.key === 'Enter' && selectionSize() === 1) {
    e.preventDefault()
    const [id] = state.selNodes.size ? state.selNodes : state.selEdges
    if (state.selEdges.size) return startEdgeLabelEdit(id)
    return startEditing(id)
  }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  if (arrows[e.key] && state.selNodes.size && !mod) {
    e.preventDefault()
    const step = gridSpacing(state.view.zoom) * (e.shiftKey ? 5 : 1)
    const [ax, ay] = arrows[e.key]
    const moving = new Set(state.selNodes)
    for (const id of state.selNodes) {
      const n = nodeById(id)
      if (n?.type === 'group') for (const c of containedNodes(n)) moving.add(c.id)
    }
    for (const id of moving) {
      const n = nodeById(id)
      n.x = Math.round((Number(n.x) || 0) + ax * step)
      n.y = Math.round((Number(n.y) || 0) + ay * step)
    }
    sync()
    commit()
  }
})
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceHeld = false
    wrapper.classList.remove('is-space-held')
  }
})
window.addEventListener('blur', () => {
  spaceHeld = false
  wrapper.classList.remove('is-space-held')
})

// ---- Controls and card menu --------------------------------------------------------------------

function quickSettings(anchor) {
  if (!isEditable()) {
    if (state.docReadOnly) return toast('This file is read-only in Orca.')
    return setReadonly(false)
  }
  const toggle = (key) => {
    state.options[key] = !state.options[key]
    try {
      localStorage.setItem('options', JSON.stringify(state.options))
    } catch {}
  }
  showMenu(
    [
      { section: 'snap', title: 'Snap to grid', checked: state.options.snapToGrid, onClick: () => toggle('snapToGrid') },
      { section: 'snap', title: 'Snap to objects', checked: state.options.snapToObjects, onClick: () => toggle('snapToObjects') },
      { section: 'mode', title: 'Read-only', icon: 'lock', onClick: () => setReadonly(true) }
    ],
    { anchor: anchor.getBoundingClientRect() }
  )
}

for (const button of document.querySelectorAll('[data-action]')) {
  if (button.dataset.icon) button.innerHTML = icon(button.dataset.icon)
  button.addEventListener('click', (e) => {
    e.stopPropagation()
    const action = button.dataset.action
    if (action === 'zoom-in') zoomBy(ZOOM_STEP)
    else if (action === 'zoom-out') zoomBy(-ZOOM_STEP)
    else if (action === 'reset') zoomBy(-state.view.zoom)
    else if (action === 'fit') zoomToFit()
    else if (action === 'help') helpEl.classList.toggle('is-open')
    else if (action === 'mode') quickSettings(button)
    else if (action === 'undo') undo()
    else if (action === 'redo') redo()
  })
}

// Card menu: click adds at the centre, dragging places a card where it is dropped.
for (const button of document.querySelectorAll('.jc-dock-button')) {
  button.innerHTML = icon(button.dataset.icon)
  const kind = button.dataset.kind
  const size = kind === 'card' ? TEXT_SIZE : FILE_SIZE
  const create = (pos, position) => {
    if (kind === 'card') createTextNode(pos, { position })
    else if (kind === 'note') addNoteAt(pos, { position })
    else addMediaAt(pos, { position })
  }
  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !isEditable()) return
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    let dummy = null
    const move = (ev) => {
      if (!dummy && Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return
      if (!dummy) {
        dummy = el('div', 'jc-card is-dummy')
        dummy.append(el('div', 'jc-card-frame'))
        canvasEl.append(dummy)
      }
      const p = toWorld(ev.clientX, ev.clientY)
      const b = placeBox(p, size, 'center')
      setGeometry(dummy, { ...b, x: snapValue(b.x), y: snapValue(b.y) })
    }
    const up = (ev) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (dummy) {
        dummy.remove()
        const overCanvas = !isUiTarget(document.elementFromPoint(ev.clientX, ev.clientY) ?? wrapper)
        if (overCanvas) {
          const p = toWorld(ev.clientX, ev.clientY)
          const b = placeBox(p, size, 'center')
          create({ x: snapValue(b.x), y: snapValue(b.y) })
        }
      } else create(viewCenter(), 'center')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })
}

new ResizeObserver(() => applyView()).observe(wrapper)
orca.on?.('theme', () => requestAnimationFrame(updateLabelForegrounds))

// ---- Document ----------------------------------------------------------------------------------

function normalize(data) {
  data = data && typeof data === 'object' ? data : {}
  data.nodes = Array.isArray(data.nodes) ? data.nodes : []
  data.edges = Array.isArray(data.edges) ? data.edges : []
  return data
}

function showMessage(text, id) {
  const msg = el('div', 'jc-notice')
  if (id) msg.id = id
  msg.textContent = text
  wrapper.append(msg)
}

let lastLoaded = null
function loadExternal(text) {
  document.getElementById('canvas-message')?.remove()
  let data
  try {
    data = text.trim() ? JSON.parse(text) : { nodes: [], edges: [] }
  } catch (error) {
    stopEditing(false)
    canvasEl.replaceChildren()
    state.els.clear()
    showMessage(`This canvas could not be read: ${error.message}. Fix it in the Source tab.`, 'canvas-message')
    setDocReadOnly(true)
    return
  }
  if (state.pendingText != null) toast('The canvas changed on disk. Showing the newer version.', 5000)
  clearTimeout(state.saveTimer)
  state.pendingText = null
  stopEditing(false)
  const previousPaths = filePaths(state.data).join('\n')
  state.data = normalize(data)
  if (!state.vault && previousPaths !== filePaths(state.data).join('\n')) state.vaultPromise = null
  state.history.reset(text)
  state.lastSent = text
  updateHistoryButtons()
  sync({ full: !state.hasView })
  if (!state.hasView) {
    state.hasView = true
    state.viewKey = viewKeyFor(state.data)
    let restored = null
    try {
      restored = JSON.parse(localStorage.getItem(state.viewKey) || 'null')
      state.readonly = localStorage.getItem(`readonly:${state.viewKey}`) === '1'
    } catch {}
    updateModeUI()
    if (restored && [restored.x, restored.y, restored.zoom].every(Number.isFinite)) setViewNow(restored.x, restored.y, clamp(restored.zoom, MIN_ZOOM, MAX_ZOOM))
    else zoomToFit(true)
  } else applyView()
  if (!state.data.nodes.length) showMessage(isEditable() ? 'Double-click to add a card, or drag one in from the toolbar below.' : 'This canvas is empty.', 'canvas-message')
}


applyView()
updateModeUI()
updateHistoryButtons()
orca.document.onDidChange((doc) => {
  if (typeof doc?.version === 'number') state.docVersion = doc.version
  setDocReadOnly(!!doc?.readOnly)
  if (doc?.content?.kind !== 'text') return
  const text = doc.content.text
  if (text === state.lastSent || text === lastLoaded) return
  if (state.hasView && text === serialize(state.data)) {
    lastLoaded = text
    return
  }
  lastLoaded = text
  loadExternal(text)
})
