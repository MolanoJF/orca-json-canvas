// The card editor: CodeMirror 6 with Obsidian-style live preview. Markdown marks (#, **, _, `,
// ~~, ==, [[ ]], link URLs) are hidden except on the lines the cursor is on, and text is styled the
// way Obsidian's editor styles it.

import {
  EditorState, EditorSelection, EditorView, keymap, Decoration, ViewPlugin, drawSelection, placeholder,
  defaultKeymap, history, historyKeymap, indentWithTab, syntaxTree, HighlightStyle, syntaxHighlighting,
  markdown, markdownLanguage, markdownKeymap, tags, Strikethrough, Table, TaskList,
  closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap
} from './vendor/codemirror.js'

const highlight = HighlightStyle.define([
  { tag: tags.heading1, class: 'jc-tok-h cm-header-1' },
  { tag: tags.heading2, class: 'jc-tok-h cm-header-2' },
  { tag: tags.heading3, class: 'jc-tok-h cm-header-3' },
  { tag: tags.heading4, class: 'jc-tok-h cm-header-4' },
  { tag: tags.heading5, class: 'jc-tok-h cm-header-5' },
  { tag: tags.heading6, class: 'jc-tok-h cm-header-6' },
  { tag: tags.strong, class: 'jc-tok-strong' },
  { tag: tags.emphasis, class: 'jc-tok-em' },
  { tag: tags.strikethrough, class: 'jc-tok-strike' },
  { tag: tags.link, class: 'jc-tok-link' },
  { tag: tags.url, class: 'jc-tok-url' },
  { tag: tags.monospace, class: 'jc-tok-code' },
  { tag: tags.quote, class: 'jc-tok-quote' },
  { tag: tags.processingInstruction, class: 'jc-tok-mark' },
  { tag: tags.contentSeparator, class: 'jc-tok-hr' },
  { tag: tags.list, class: 'jc-tok-list' }
])

const hidden = Decoration.replace({})
const lineClass = (cls) => Decoration.line({ class: cls })
const mark = (cls) => Decoration.mark({ class: cls })

function activeLines(state) {
  const set = new Set()
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number
    const b = state.doc.lineAt(r.to).number
    for (let i = a; i <= b; i++) set.add(i)
  }
  return set
}

// Decorations: heading line classes, hidden marks on inactive lines, and the Obsidian syntax the
// markdown grammar does not know ([[links]], ==highlights==, #tags, %%comments%%).
function buildDecorations(view) {
  const { state } = view
  const active = view.hasFocus ? activeLines(state) : new Set()
  const decos = []
  const isActive = (pos) => active.has(state.doc.lineAt(pos).number)

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name
        const m = /^ATXHeading(\d)$/.exec(name)
        if (m) {
          decos.push(lineClass(`jc-ed-h jc-ed-h${m[1]}`).range(state.doc.lineAt(node.from).from))
          return
        }
        if (name === 'Blockquote') {
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos)
            decos.push(lineClass('jc-ed-quote').range(line.from))
            pos = line.to + 1
          }
          return
        }
        if (name === 'FencedCode') {
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos)
            decos.push(lineClass('jc-ed-code').range(line.from))
            pos = line.to + 1
          }
          return
        }
        if (isActive(node.from)) return
        if (name === 'HeaderMark') {
          const after = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
          decos.push(hidden.range(node.from, after))
        } else if (name === 'EmphasisMark' || name === 'StrikethroughMark') {
          decos.push(hidden.range(node.from, node.to))
        } else if (name === 'CodeMark' && node.node.parent?.name === 'InlineCode') {
          decos.push(hidden.range(node.from, node.to))
        } else if (name === 'Link') {
          // [text](url): keep only the text.
          const marks = []
          let url = null
          for (let c = node.node.firstChild; c; c = c.nextSibling) {
            if (c.name === 'LinkMark') marks.push(c)
            if (c.name === 'URL') url = c
          }
          if (marks.length >= 2 && url) {
            decos.push(hidden.range(marks[0].from, marks[0].to))
            decos.push(hidden.range(marks[1].from, node.to))
            decos.push(mark('jc-tok-link jc-tok-live-link').range(marks[0].to, marks[1].from))
          }
        }
      }
    })

    // Obsidian-only syntax, by line.
    const text = state.doc.sliceString(from, to)
    const re = /(\[\[([^\]\n]+?)\]\])|(==(?=\S)([^=\n]*?\S)==)|(%%[^\n]*?%%)|((?:^|(?<=[\s(]))#[\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gmu
    for (let m; (m = re.exec(text)); ) {
      const start = from + m.index
      const end = start + m[0].length
      const inactive = !isActive(start)
      if (m[1]) {
        const inner = m[2]
        const bar = inner.indexOf('|')
        const shownFrom = bar >= 0 ? start + 2 + bar + 1 : start + 2
        decos.push(mark('jc-tok-wikilink').range(shownFrom, end - 2))
        if (inactive) {
          decos.push(hidden.range(start, shownFrom))
          decos.push(hidden.range(end - 2, end))
        } else {
          decos.push(mark('jc-tok-wikimark').range(start, start + 2))
          decos.push(mark('jc-tok-wikimark').range(end - 2, end))
        }
      } else if (m[3]) {
        decos.push(mark('jc-tok-highlight').range(start + 2, end - 2))
        if (inactive) {
          decos.push(hidden.range(start, start + 2))
          decos.push(hidden.range(end - 2, end))
        } else {
          decos.push(mark('jc-tok-highlight-mark').range(start, start + 2))
          decos.push(mark('jc-tok-highlight-mark').range(end - 2, end))
        }
      } else if (m[5]) {
        decos.push(mark('jc-tok-comment').range(start, end))
      } else if (m[6]) {
        decos.push(mark('jc-tok-tag').range(start, end))
      }
    }
  }
  return Decoration.set(decos, true)
}

const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view)
    }
    update(u) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
        this.decorations = buildDecorations(u.view)
    }
  },
  { decorations: (v) => v.decorations }
)

// Ctrl/Cmd+B and +I wrap or unwrap the selection, as in Obsidian.
function toggleWrap(marker) {
  return (view) => {
    const { state } = view
    const changes = state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - marker.length, range.from)
      const after = state.sliceDoc(range.to, range.to + marker.length)
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - marker.length, to: range.from, insert: '' },
            { from: range.to, to: range.to + marker.length, insert: '' }
          ],
          range: EditorSelection.range(range.from - marker.length, range.to - marker.length)
        }
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker }
        ],
        range: EditorSelection.range(range.from + marker.length, range.to + marker.length)
      }
    })
    view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }))
    return true
  }
}

// [[ completion from the vault's notes and files.
function linkCompletion(getFiles) {
  return async (context) => {
    const m = context.matchBefore(/\[\[[^\]\n|#]*$/)
    if (!m) return null
    const files = await getFiles()
    const query = m.text.slice(2).toLowerCase()
    const options = files
      .filter((f) => !query || f.toLowerCase().includes(query))
      .slice(0, 200)
      .map((f) => {
        const isMd = f.toLowerCase().endsWith('.md')
        const name = f.slice(f.lastIndexOf('/') + 1)
        const label = isMd ? name.slice(0, -3) : name
        return { label, detail: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '', apply: `[[${label}]]` }
      })
    return {
      from: m.from,
      to: context.state.sliceDoc(context.pos, context.pos + 2) === ']]' ? context.pos + 2 : context.pos,
      options,
      filter: false
    }
  }
}

export function createTextEditor({ parent, text, onChange, onExit, getFiles, readOnly = false }) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        drawSelection(),
        closeBrackets(),
        autocompletion({ override: [linkCompletion(getFiles)], icons: false }),
        markdown({ base: markdownLanguage, extensions: [Strikethrough, Table, TaskList], addKeymap: true }),
        syntaxHighlighting(highlight),
        livePreview,
        EditorView.lineWrapping,
        placeholder(''),
        EditorState.readOnly.of(readOnly),
        keymap.of([
          { key: 'Escape', run: () => (onExit(), true) },
          { key: 'Mod-b', run: toggleWrap('**') },
          { key: 'Mod-i', run: toggleWrap('*') },
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...markdownKeymap,
          ...historyKeymap,
          ...defaultKeymap,
          indentWithTab
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString())
        }),
        EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences' })
      ]
    })
  })
  return view
}
