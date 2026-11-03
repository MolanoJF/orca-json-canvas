// Canvas data helpers: Obsidian's serializer (so saved files match what Obsidian writes), node
// ids, and a snapshot undo history.

const isPrimitive = (v) => v === null || typeof v !== 'object'

// The layout Obsidian writes canvas files in: tab-indented, with any object or array whose values are all
// primitives written on one line (so each card is one line).
function lines(value) {
  if (value === undefined) return ['null']
  if (isPrimitive(value) || Object.prototype.toString.call(value) === '[object Date]') return [JSON.stringify(value)]
  if (Array.isArray(value)) {
    if (value.every(isPrimitive)) return [JSON.stringify(value)]
    const out = ['[']
    value.forEach((item, i) => {
      const inner = lines(item)
      inner.forEach((line, j) => out.push('\t' + line + (j === inner.length - 1 && i !== value.length - 1 ? ',' : '')))
    })
    out.push(']')
    return out
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined)
  if (keys.every((k) => isPrimitive(value[k]))) return [JSON.stringify(Object.fromEntries(keys.map((k) => [k, value[k]])))]
  const out = ['{']
  keys.forEach((key, i) => {
    const inner = lines(value[key])
    inner[0] = JSON.stringify(key) + ':' + inner[0]
    inner.forEach((line, j) => out.push('\t' + line + (j === inner.length - 1 && i !== keys.length - 1 ? ',' : '')))
  })
  out.push('}')
  return out
}

export function serialize(data) {
  const out = {}
  for (const [k, v] of Object.entries(data)) if (k !== 'nodes' && k !== 'edges') out[k] = v
  // Obsidian keeps the document's other keys, then writes nodes and edges.
  const ordered = {}
  const keys = Object.keys(data)
  const hasNodes = keys.includes('nodes')
  const hasEdges = keys.includes('edges')
  for (const k of keys) {
    if (k === 'nodes') ordered.nodes = data.nodes.map(cleanNode)
    else if (k === 'edges') ordered.edges = data.edges.map(cleanEdge)
    else ordered[k] = data[k]
  }
  if (!hasNodes) ordered.nodes = data.nodes.map(cleanNode)
  if (!hasEdges) ordered.edges = data.edges.map(cleanEdge)
  return lines(ordered).join('\n')
}

// Obsidian rounds geometry and drops empty optional fields.
function cleanNode(n) {
  const out = {}
  for (const [k, v] of Object.entries(n)) {
    if (k.startsWith('_')) continue
    if ((k === 'x' || k === 'y' || k === 'width' || k === 'height') && typeof v === 'number') out[k] = Math.round(v)
    else if ((k === 'color' || k === 'subpath' || k === 'label') && (v === '' || v == null)) continue
    else out[k] = v
  }
  return out
}

function cleanEdge(e) {
  const out = {}
  for (const [k, v] of Object.entries(e)) {
    if (k.startsWith('_')) continue
    if ((k === 'color' || k === 'label') && (v === '' || v == null)) continue
    if (k === 'fromEnd' && v === 'none') continue
    if (k === 'toEnd' && v === 'arrow') continue
    out[k] = v
  }
  return out
}

export function newId() {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Snapshot history of serialized documents.
export class History {
  constructor(limit = 200) {
    this.limit = limit
    this.reset('')
  }
  reset(text) {
    this.stack = [text]
    this.index = 0
  }
  get current() {
    return this.stack[this.index]
  }
  push(text) {
    if (text === this.current) return false
    this.stack = this.stack.slice(0, this.index + 1)
    this.stack.push(text)
    if (this.stack.length > this.limit) this.stack.shift()
    this.index = this.stack.length - 1
    return true
  }
  // Replaces the newest entry, for edits that continue the previous one (typing).
  amend(text) {
    if (this.index === 0) return this.push(text)
    this.stack = this.stack.slice(0, this.index + 1)
    this.stack[this.index] = text
    return true
  }
  get canUndo() {
    return this.index > 0
  }
  get canRedo() {
    return this.index < this.stack.length - 1
  }
  undo() {
    if (!this.canUndo) return null
    this.index--
    return this.current
  }
  redo() {
    if (!this.canRedo) return null
    this.index++
    return this.current
  }
}
