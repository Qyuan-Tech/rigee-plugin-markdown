/**
 * Find in the document, as a browser's find bar does it.
 *
 * Matches are DOM Ranges over the text that is on the page, painted with the CSS Custom Highlight
 * API rather than wrapped in marks. Nothing is added to the document, so a redraw when the file
 * changes, code coloured after the document is drawn, or a picture standing in as its alt text can
 * neither be broken by the highlights nor leave stale ones behind: the preview finds again, and
 * paints what it found.
 *
 * Text is searched as it reads, not as it is split into nodes: `Some **bold**` is found as "some
 * bold", and a token boundary in a coloured code block is invisible. It is never searched ACROSS a
 * block — a match does not run from the end of one paragraph into the next, or from one table
 * cell into the one beside it.
 */

/** Past this many matches the rest are not looked for: each is a Range the page paints. */
const MAX_MATCHES = 10_000

/** Elements that start a line of their own. A match never spans two of them. */
const BLOCKS = new Set([
  'ARTICLE', 'BLOCKQUOTE', 'CAPTION', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'LI', 'OL', 'P', 'PRE', 'SUMMARY', 'TABLE', 'TBODY',
  'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
])

/**
 * Between two blocks in the text searched. A character no query can contain: the box takes one
 * line, and the HTML parser never leaves a NUL in a text node.
 */
const BETWEEN = '\0'

export interface Found {
  ranges: Range[]
  /** There were more than MAX_MATCHES, and the rest were not looked for. */
  more: boolean
}

export const NOTHING_FOUND: Found = { ranges: [], more: false }

/**
 * Every place `query` appears in the text under `root`, in document order. Case is ignored, and a
 * space in the query matches any run of white space, as the page collapses it — a soft line break
 * in the source included.
 */
export function findMatches(root: Element, query: string): Found {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return NOTHING_FOUND
  const pattern = new RegExp(words.map(escape).join('\\s+'), 'giu')

  const runs: { node: Text; start: number }[] = []
  let text = ''
  let block: Element | null = null
  let broken = false
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if ((node as Element).tagName === 'BR') broken = true
      continue
    }
    const parent = node.parentElement
    // A ruby's fallback parentheses are not drawn.
    if (!parent || parent.tagName === 'RP' || !(node as Text).data) continue
    const here = blockOf(parent, root)
    if (here !== block || broken) text += BETWEEN
    block = here
    broken = false
    runs.push({ node: node as Text, start: text.length })
    text += (node as Text).data
  }

  const ranges: Range[] = []
  let at = 0
  for (const match of text.matchAll(pattern)) {
    if (ranges.length === MAX_MATCHES) return { ranges, more: true }
    const start = match.index
    const end = start + match[0].length
    while (at + 1 < runs.length && runs[at + 1]!.start <= start) at++
    let last = at
    while (last + 1 < runs.length && runs[last + 1]!.start < end) last++
    const range = document.createRange()
    range.setStart(runs[at]!.node, start - runs[at]!.start)
    range.setEnd(runs[last]!.node, end - runs[last]!.start)
    ranges.push(range)
  }
  return { ranges, more: false }
}

function blockOf(el: Element, root: Element): Element {
  for (let at: Element | null = el; at && at !== root; at = at.parentElement) {
    if (BLOCKS.has(at.tagName)) return at
  }
  return root
}

/** Only the syntax characters: under the `u` flag, escaping any other — `\-` — is itself an error. */
function escape(word: string): string {
  return word.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
}

/**
 * Which match to start on for a query the reader has just typed: the first at or after the one
 * they were on, so a longer query stays where they are — or, with none, the first at or below the
 * top of what they can see, rather than the first in the document.
 */
export function startingMatch(ranges: Range[], from: Range | null, scroller: HTMLElement): number {
  if (ranges.length === 0) return -1
  let at: number
  if (from && !from.collapsed && from.startContainer.isConnected) {
    at = ranges.findIndex((r) => r.compareBoundaryPoints(Range.START_TO_START, from) >= 0)
  } else {
    const top = scroller.getBoundingClientRect().top
    at = ranges.findIndex((r) => r.getBoundingClientRect().bottom > top)
  }
  return at < 0 ? 0 : at
}

/**
 * Put a match where the reader can see it: open the `<details>` it is folded away in, scroll a
 * wide code block or table sideways to it, and scroll the document to it — a third of the way
 * down, as a browser's find does — unless it is already in view.
 */
export function bringIntoView(range: Range, scroller: HTMLElement): void {
  let child: Element | null = null
  for (let el = range.startContainer.parentElement; el && el !== scroller; child = el, el = el.parentElement) {
    // Not one whose summary the match is in: that is on the page with the details closed.
    if (el instanceof HTMLDetailsElement && !el.open && child?.tagName !== 'SUMMARY') el.open = true
  }
  for (let el = range.startContainer.parentElement; el && el !== scroller; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth) continue
    const rect = range.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    if (rect.left < box.left || rect.right > box.right) el.scrollLeft += rect.left - box.left - box.width / 3
  }
  const rect = range.getBoundingClientRect()
  const box = scroller.getBoundingClientRect()
  if (rect.top < box.top || rect.bottom > box.bottom) scroller.scrollTop += rect.top - box.top - box.height / 3
}

/*
 * The highlights. One pair for the whole window, named in markdown.css, holding every open find
 * bar's matches: a split shows two previews, and each pane adds and takes away only its own.
 */
const ALL = 'markdown-find'
const ACTIVE = 'markdown-find-active'
let shared: { all: Highlight; active: Highlight } | null = null
const painted = new Map<object, { ranges: Range[]; active: Range | null }>()

/** Paint `ranges` as `pane`'s matches, and `active` as the one it is on, in place of what it painted before. */
export function paintMatches(pane: object, ranges: Range[], active: Range | null): void {
  if (!shared) {
    shared = { all: new Highlight(), active: new Highlight() }
    shared.active.priority = 1
    CSS.highlights.set(ALL, shared.all)
    CSS.highlights.set(ACTIVE, shared.active)
  }
  const before = painted.get(pane)
  if (before) {
    for (const range of before.ranges) shared.all.delete(range)
    if (before.active) shared.active.delete(before.active)
  }
  if (ranges.length === 0) {
    painted.delete(pane)
    return
  }
  for (const range of ranges) shared.all.add(range)
  if (active) shared.active.add(active)
  painted.set(pane, { ranges, active })
}
