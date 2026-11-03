// Dev harness: serves the plugin's editor frame with a mock `window.orca`, and answers
// plugin.request by running the real worker module in this Node process.
//   node harness.mjs <canvas file> [port]
import http from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = path.resolve(import.meta.dirname, '..')
const canvasFile = path.resolve(process.argv[2])
const port = Number(process.argv[3] || 5179)

const handlers = new Map()
const fakeOrca = {
  log: (m) => console.log('[worker]', m),
  host: { has: () => false, call: async () => { throw Object.assign(new Error('unavailable'), { code: 'unavailable' }) } },
  panels: { handle: (name, fn) => handlers.set(name, fn), post: () => {} },
  settings: { get: async () => process.env.VAULT || '' }
}
const worker = await import(pathToFileURL(path.join(PLUGIN, 'worker', 'main.js')).href)
worker.default(fakeOrca)
// Never write vault notes from the harness.
handlers.set('canvas.writeText', async (input) => {
  console.log('[writeText]', input.path, input.part, input.parts, String(input.text).length)
  return { done: input.part === input.parts - 1, mtime: Date.now() }
})
// Never open real tabs from the harness.
handlers.set('canvas.open', async (input) => {
  console.log('[open]', JSON.stringify(input))
  return { opened: true, via: 'harness' }
})

const MOCK = `
window.__log = [];
const qs = new URLSearchParams(location.search);
document.documentElement.className = qs.get('theme') || 'dark';
window.orca = Object.freeze({
  api: { major: 1, minor: 2 },
  host: {
    has: (m) => ['plugin.request', 'workspace.readContext', 'shell.openExternal'].includes(m),
    call: async (m, p) => {
      if (m === 'plugin.request') {
        const r = await fetch('/__request', { method: 'POST', body: JSON.stringify(p) });
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
        return { output: j.output };
      }
      if (m === 'workspace.readContext') return { displayName: "JSON Canvas demo", branch: '', terminals: [] };
      if (m === 'shell.openExternal') { window.__log.push('openExternal ' + p.url); return { opened: true }; }
      throw Object.assign(new Error('unknown'), { code: 'unknown_method' });
    }
  },
  shell: { openExternal: async (url) => { window.__log.push('openExternal ' + url); return { opened: true }; } },
  on: (name, fn) => { (window.__on ||= {})[name] = fn; },
  document: {
    get: async () => ({ version: 1, readOnly: false, content: { kind: 'text', text: await (await fetch('/__doc')).text() } }),
    onDidChange(cb) { window.__docCb = cb; fetch('/__doc').then((r) => r.text()).then((t) => cb({ version: 1, readOnly: false, content: { kind: 'text', text: t } })); },
    applyEdit: async ({ baseVersion, content }) => { window.__saved = content.text; window.__saves = (window.__saves || 0) + 1; return { version: baseVersion }; }
  }
});
`

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      if (url.pathname === '/__doc') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end(await fs.readFile(canvasFile, 'utf8'))
      }
      if (url.pathname === '/__mock.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' })
        return res.end(MOCK)
      }
      if (url.pathname === '/__request') {
        let body = ''
        for await (const c of req) body += c
        const { name, input } = JSON.parse(body)
        const fn = handlers.get(name)
        res.writeHead(200, { 'content-type': 'application/json' })
        if (!fn) return res.end(JSON.stringify({ error: { code: 'unknown_method', message: name } }))
        try {
          return res.end(JSON.stringify({ output: await fn(input ?? {}, {}) }))
        } catch (error) {
          return res.end(JSON.stringify({ error: { code: error.code || 'action_failed', message: error.message } }))
        }
      }
      const rel = url.pathname === '/' ? '/editor/index.html' : decodeURIComponent(url.pathname)
      const file = path.join(PLUGIN, rel)
      if (!file.startsWith(PLUGIN + path.sep)) throw new Error('outside')
      let data = await fs.readFile(file)
      if (rel.endsWith('index.html')) data = String(data).replace('<head>', '<head><script src="/__mock.js"></script>')
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
      res.end(data)
    } catch (error) {
      res.writeHead(404)
      res.end(String(error.message))
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`harness on http://127.0.0.1:${port}/editor/index.html`))
