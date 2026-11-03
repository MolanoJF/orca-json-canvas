// Markdown rendering with Obsidian's flavour on top of marked (GFM): [[wikilinks]], ![[embeds]],
// ==highlights==, #tags, %%comments%%, callouts and soft line breaks. Output is sanitized: the
// frame has no network, but we still strip scripts and event handlers from inline HTML.

import { Marked } from './vendor/marked.esm.js'

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

// "note#Heading|Alias" -> { target, subpath, alias }
export function parseLinkText(inner) {
  const raw = String(inner).replace(/\\\|/g, '|')
  const bar = raw.indexOf('|')
  const left = bar >= 0 ? raw.slice(0, bar) : raw
  const alias = bar >= 0 ? raw.slice(bar + 1).trim() : ''
  const hash = left.indexOf('#')
  const target = (hash >= 0 ? left.slice(0, hash) : left).trim()
  const subpath = hash >= 0 ? left.slice(hash).trim() : ''
  return { target, subpath, alias }
}

function linkDisplay({ target, subpath, alias }) {
  if (alias) return alias
  const sub = subpath.replace(/^#/, '').split('#').filter(Boolean)
  const base = target.replace(/\.md$/i, '')
  const shown = base.includes('/') ? base.slice(base.lastIndexOf('/') + 1) : base
  if (!sub.length) return shown
  return [shown, ...sub].filter(Boolean).join(' > ')
}

const wikiEmbed = {
  name: 'wikiEmbed',
  level: 'inline',
  start: (src) => src.indexOf('![['),
  tokenizer(src) {
    const m = /^!\[\[([^\]\n]+?)\]\]/.exec(src)
    if (m) return { type: 'wikiEmbed', raw: m[0], inner: m[1] }
  },
  renderer(token) {
    const link = parseLinkText(token.inner)
    return `<span class="jc-embed" data-target="${esc(link.target)}" data-subpath="${esc(link.subpath)}" data-alias="${esc(link.alias)}"></span>`
  }
}

const wikiLink = {
  name: 'wikiLink',
  level: 'inline',
  start: (src) => src.indexOf('[['),
  tokenizer(src) {
    const m = /^\[\[([^\]\n]+?)\]\]/.exec(src)
    if (m) return { type: 'wikiLink', raw: m[0], inner: m[1] }
  },
  renderer(token) {
    const link = parseLinkText(token.inner)
    return `<a class="jc-link-internal" data-target="${esc(link.target)}" data-subpath="${esc(link.subpath)}">${esc(linkDisplay(link))}</a>`
  }
}

const highlight = {
  name: 'highlight',
  level: 'inline',
  start: (src) => src.indexOf('=='),
  tokenizer(src) {
    const m = /^==(?=\S)([\s\S]*?\S)==(?!=)/.exec(src)
    if (m) return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) }
  },
  renderer(token) {
    return `<mark>${this.parser.parseInline(token.tokens)}</mark>`
  }
}

const TAG_RE = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u
const tag = {
  name: 'tag',
  level: 'inline',
  start(src) {
    const m = /(^|[\s(])#[\p{L}\p{N}_\-/]/u.exec(src)
    return m ? m.index + m[1].length : undefined
  },
  tokenizer(src) {
    const m = TAG_RE.exec(src)
    if (m) return { type: 'tag', raw: m[0], name: m[1] }
  },
  renderer(token) {
    return `<a class="jc-tag" data-tag="${esc(token.name)}">#${esc(token.name)}</a>`
  }
}

const inlineComment = {
  name: 'inlineComment',
  level: 'inline',
  start: (src) => src.indexOf('%%'),
  tokenizer(src) {
    const m = /^%%[\s\S]*?%%/.exec(src)
    if (m) return { type: 'inlineComment', raw: m[0] }
  },
  renderer: () => ''
}

const blockComment = {
  name: 'blockComment',
  level: 'block',
  start: (src) => src.indexOf('%%'),
  tokenizer(src) {
    const m = /^%%[\s\S]*?%%[^\S\n]*(?:\n|$)/.exec(src)
    if (m) return { type: 'blockComment', raw: m[0] }
  },
  renderer: () => ''
}

const marked = new Marked({ gfm: true, breaks: true, async: false })
marked.use({ extensions: [blockComment, wikiEmbed, wikiLink, highlight, inlineComment, tag] })

export function stripFrontmatter(text) {
  return String(text).replace(/^---\r?\n[\s\S]*?\r?\n---[^\S\n]*(\r?\n|$)/, '')
}

// The part of a note that a #Heading or #^block subpath names, as Obsidian embeds it.
export function extractSection(text, subpath) {
  const parts = String(subpath || '').replace(/^#/, '').split('#').filter(Boolean)
  if (!parts.length) return text
  const lines = text.split(/\r?\n/)
  const last = parts[parts.length - 1]
  const normalize = (s) => s.replace(/[\[\]#^|*_`~=]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  if (last.startsWith('^')) {
    const id = last.slice(1)
    const i = lines.findIndex((l) => new RegExp(`(^|\\s)\\^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(l))
    if (i < 0) return null
    let start = i
    while (start > 0 && lines[start - 1].trim()) start--
    return lines.slice(start, i + 1).join('\n').replace(/\s\^[\w-]+\s*$/, '')
  }
  const want = normalize(last)
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence
    if (inFence) continue
    const m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i])
    if (m && normalize(m[2]) === want) {
      const level = m[1].length
      let end = lines.length
      let fence = false
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*(```|~~~)/.test(lines[j])) fence = !fence
        if (fence) continue
        const n = /^\s{0,3}(#{1,6})\s/.exec(lines[j])
        if (n && n[1].length <= level) {
          end = j
          break
        }
      }
      return lines.slice(i, end).join('\n')
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Sanitizing and Obsidian post-processing on the DOM

const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'TEXTAREA', 'SELECT', 'BUTTON', 'FRAME', 'FRAMESET', 'NOSCRIPT', 'TEMPLATE'])

function sanitize(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  const remove = []
  for (let el = walker.nextNode(); el; el = walker.nextNode()) {
    if (DROP.has(el.tagName) || (el.tagName === 'INPUT' && el.getAttribute('type') !== 'checkbox')) {
      remove.push(el)
      continue
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      const value = attr.value.trim().toLowerCase()
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') el.removeAttribute(attr.name)
      else if ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action') && /^(javascript|vbscript):/.test(value))
        el.removeAttribute(attr.name)
      else if (name === 'src' && value.startsWith('data:') && !value.startsWith('data:image/')) el.removeAttribute(attr.name)
    }
  }
  for (const el of remove) el.remove()
}

const CALLOUT_RE = /^\[!([^\]\s]+)\]([+-]?)[^\S\n]*(.*)$/

function decorate(root) {
  // Links: external vs. internal markdown links.
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href')
    if (/^(https?:|mailto:)/i.test(href)) {
      a.classList.add('jc-link-external')
      a.dataset.external = href
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      a.classList.add('jc-link-external')
      a.dataset.external = href
    } else if (href.startsWith('#')) {
      a.classList.add('jc-link-internal')
      a.dataset.target = ''
      a.dataset.subpath = href
    } else {
      let decoded = href
      try {
        decoded = decodeURI(href)
      } catch {}
      const hash = decoded.indexOf('#')
      a.classList.add('jc-link-internal')
      a.dataset.target = hash >= 0 ? decoded.slice(0, hash) : decoded
      a.dataset.subpath = hash >= 0 ? decoded.slice(hash) : ''
    }
    a.removeAttribute('href')
  }
  // Task lists.
  for (const box of root.querySelectorAll('li > input[type=checkbox]')) {
    const li = box.parentElement
    li.classList.add('jc-task')
    if (box.checked) li.classList.add('is-checked')
    box.disabled = true
    li.parentElement?.classList.add('jc-tasks')
  }
  // Callouts: > [!type] Title
  for (const quote of [...root.querySelectorAll('blockquote')]) {
    const first = quote.firstElementChild
    if (!first || first.tagName !== 'P') continue
    const firstLine = first.innerHTML.split(/<br\s*\/?>\s*\n?/i)
    const probe = document.createElement('div')
    probe.innerHTML = firstLine[0]
    const m = CALLOUT_RE.exec(probe.textContent.trim())
    if (!m) continue
    const type = m[1].toLowerCase()
    const callout = document.createElement('div')
    callout.className = 'jc-callout'
    callout.dataset.callout = type
    const title = document.createElement('div')
    title.className = 'jc-callout-title'
    const titleInner = document.createElement('div')
    titleInner.className = 'jc-callout-title-text'
    const titleHtml = firstLine[0].replace(/^\s*\[![^\]]+\][+-]?\s*/, '')
    if (titleHtml.trim()) titleInner.innerHTML = titleHtml
    else titleInner.textContent = type.charAt(0).toUpperCase() + type.slice(1)
    title.append(titleInner)
    const content = document.createElement('div')
    content.className = 'jc-callout-body'
    const rest = firstLine.slice(1).join('<br>')
    if (rest.trim()) {
      const p = document.createElement('p')
      p.innerHTML = rest
      content.append(p)
    }
    first.remove()
    while (quote.firstChild) content.append(quote.firstChild)
    callout.append(title)
    if (content.childNodes.length) callout.append(content)
    quote.replaceWith(callout)
  }
}

// Renders markdown into a `.jc-md-body` element.
export function renderMarkdown(text) {
  const html = marked.parse(String(text ?? ''))
  const template = document.createElement('template')
  template.innerHTML = html
  const sizer = document.createElement('div')
  sizer.className = 'jc-md-body jc-md-section'
  sizer.append(template.content)
  sanitize(sizer)
  decorate(sizer)
  return sizer
}
