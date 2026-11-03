// Menus, the file picker and a text prompt for the editor frame.

import { icon } from './icons.js'

let openMenuEl = null
let closeOpenMenu = null

export function closeMenu() {
  closeOpenMenu?.()
}

// items: { title, icon, onClick, checked, warning, disabled, section } or '-' for a separator.
// Separators between sections are added automatically, as Obsidian groups items by section.
export function showMenu(items, { x, y, anchor }) {
  closeMenu()
  const menu = document.createElement('div')
  menu.className = 'jc-menu'
  let lastSection
  let count = 0
  for (const item of items) {
    if (!item) continue
    if (item === '-') {
      if (count) menu.append(sep())
      lastSection = undefined
      continue
    }
    if (count && item.section !== undefined && lastSection !== undefined && item.section !== lastSection) menu.append(sep())
    lastSection = item.section
    const row = document.createElement('div')
    row.className = `jc-menu-item${item.warning ? ' is-danger' : ''}${item.disabled ? ' is-disabled' : ''}`
    const ic = document.createElement('div')
    ic.className = 'jc-menu-icon'
    ic.innerHTML = item.icon ? icon(item.icon) : ''
    const title = document.createElement('div')
    title.className = 'jc-menu-label'
    title.textContent = item.title
    row.append(ic, title)
    if (item.checked) {
      const check = document.createElement('div')
      check.className = 'jc-menu-icon is-check'
      check.innerHTML = icon('check')
      row.append(check)
    }
    if (item.hint) {
      const hint = document.createElement('div')
      hint.className = 'jc-menu-hint'
      hint.textContent = item.hint
      row.append(hint)
    }
    row.addEventListener('pointerenter', () => {
      for (const r of menu.querySelectorAll('.jc-menu-item.is-hover')) r.classList.remove('is-hover')
      row.classList.add('is-hover')
    })
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      if (item.disabled) return
      closeMenu()
      item.onClick?.(e)
    })
    menu.append(row)
    count++
  }
  if (!count) return
  document.body.append(menu)
  const rect = menu.getBoundingClientRect()
  let left = x
  let top = y
  if (anchor) {
    left = anchor.left
    top = anchor.bottom + 4
  }
  left = Math.max(4, Math.min(left, window.innerWidth - rect.width - 4))
  if (top + rect.height > window.innerHeight - 4) top = Math.max(4, (anchor ? anchor.top - 4 : y) - rect.height)
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  openMenuEl = menu
  const onDown = (e) => {
    if (!menu.contains(e.target)) closeMenu()
  }
  const onKey = (e) => {
    const rows = [...menu.querySelectorAll('.jc-menu-item:not(.is-disabled)')]
    const i = rows.findIndex((r) => r.classList.contains('is-hover'))
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeMenu()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      rows[i]?.classList.remove('is-hover')
      const next = rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length] ?? rows[0]
      next?.classList.add('is-hover')
    } else if (e.key === 'Enter' && i >= 0) {
      e.preventDefault()
      e.stopPropagation()
      rows[i].click()
    }
  }
  setTimeout(() => {
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
  })
  closeOpenMenu = () => {
    window.removeEventListener('pointerdown', onDown, true)
    window.removeEventListener('keydown', onKey, true)
    menu.remove()
    if (openMenuEl === menu) openMenuEl = null
    closeOpenMenu = null
  }
}

function sep() {
  const s = document.createElement('div')
  s.className = 'jc-menu-sep'
  return s
}

export const isMenuOpen = () => !!openMenuEl

// ---- Modals ------------------------------------------------------------------------------------

let modalOpen = false
export const isModalOpen = () => modalOpen

function modalShell() {
  const container = document.createElement('div')
  container.className = 'jc-modal-layer is-dim'
  const bg = document.createElement('div')
  bg.className = 'jc-modal-backdrop'
  container.append(bg)
  document.body.append(container)
  modalOpen = true
  return { container, bg }
}

// Fuzzy file picker, like Obsidian's "Add note from vault".
export function openSuggester({ placeholder, load, render, onChoose, emptyText = 'No matches.' }) {
  const { container, bg } = modalShell()
  const prompt = document.createElement('div')
  prompt.className = 'jc-picker'
  const inputWrap = document.createElement('div')
  inputWrap.className = 'jc-picker-field'
  const input = document.createElement('input')
  input.className = 'jc-picker-input'
  input.type = 'text'
  input.placeholder = placeholder
  input.spellcheck = false
  inputWrap.append(input)
  const results = document.createElement('div')
  results.className = 'jc-picker-list'
  const instructions = document.createElement('div')
  instructions.className = 'jc-picker-hints'
  instructions.innerHTML =
    '<div class="jc-picker-hint"><span class="jc-picker-key">↑↓</span><span>to navigate</span></div>' +
    '<div class="jc-picker-hint"><span class="jc-picker-key">↵</span><span>to use</span></div>' +
    '<div class="jc-picker-hint"><span class="jc-picker-key">esc</span><span>to dismiss</span></div>'
  prompt.append(inputWrap, results, instructions)
  container.append(prompt)

  let all = []
  let shown = []
  let selected = 0
  const close = () => {
    container.remove()
    modalOpen = false
  }
  const choose = (item) => {
    close()
    onChoose(item)
  }
  const draw = () => {
    const q = input.value.trim().toLowerCase()
    const terms = q.split(/\s+/).filter(Boolean)
    shown = all
      .map((item) => {
        const hay = item.toLowerCase()
        if (!terms.every((t) => hay.includes(t))) return null
        const name = hay.slice(hay.lastIndexOf('/') + 1)
        const score = terms.reduce((s, t) => s + (name.includes(t) ? 2 : 0) + (name.startsWith(t) ? 3 : 0), 0) - hay.length / 1000
        return { item, score }
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 300)
      .map((x) => x.item)
    selected = Math.min(selected, Math.max(0, shown.length - 1))
    results.replaceChildren()
    if (!shown.length) {
      const empty = document.createElement('div')
      empty.className = 'jc-picker-empty'
      empty.textContent = all.length ? emptyText : 'Loading…'
      results.append(empty)
      return
    }
    shown.forEach((item, i) => {
      const row = document.createElement('div')
      row.className = `jc-picker-item is-rich${i === selected ? ' is-selected' : ''}`
      const { title, note } = render(item)
      const content = document.createElement('div')
      content.className = 'jc-picker-text'
      const t = document.createElement('div')
      t.className = 'jc-picker-title'
      t.textContent = title
      content.append(t)
      if (note) {
        const n = document.createElement('div')
        n.className = 'jc-picker-note'
        n.textContent = note
        content.append(n)
      }
      row.append(content)
      row.addEventListener('pointermove', () => {
        if (selected === i) return
        results.querySelector('.is-selected')?.classList.remove('is-selected')
        row.classList.add('is-selected')
        selected = i
      })
      row.addEventListener('click', () => choose(item))
      results.append(row)
    })
  }
  input.addEventListener('input', () => {
    selected = 0
    draw()
  })
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!shown.length) return
      selected = (selected + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length
      draw()
      results.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (shown[selected] != null) choose(shown[selected])
    }
  })
  bg.addEventListener('click', close)
  draw()
  input.focus()
  load().then((items) => {
    all = items
    draw()
  })
}

// A one-line prompt, like Obsidian's "Enter URL".
export function openPrompt({ title, placeholder, value = '', validate, onSubmit }) {
  const { container, bg } = modalShell()
  const modal = document.createElement('div')
  modal.className = 'jc-dialog'
  const header = document.createElement('div')
  header.className = 'jc-dialog-title'
  header.textContent = title
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'jc-dialog-input'
  input.placeholder = placeholder ?? ''
  input.value = value
  input.spellcheck = false
  const error = document.createElement('div')
  error.className = 'jc-dialog-error'
  const buttons = document.createElement('div')
  buttons.className = 'jc-dialog-actions'
  const ok = document.createElement('button')
  ok.className = 'is-primary'
  ok.textContent = 'Save'
  const cancel = document.createElement('button')
  cancel.textContent = 'Cancel'
  buttons.append(ok, cancel)
  modal.append(header, input, error, buttons)
  container.append(modal)
  const close = () => {
    container.remove()
    modalOpen = false
  }
  const submit = () => {
    const v = input.value.trim()
    const problem = validate?.(v)
    if (problem) {
      error.textContent = problem
      return
    }
    close()
    onSubmit(v)
  }
  ok.addEventListener('click', submit)
  cancel.addEventListener('click', close)
  bg.addEventListener('click', close)
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') submit()
    if (e.key === 'Escape') close()
  })
  input.focus()
  input.select()
}
