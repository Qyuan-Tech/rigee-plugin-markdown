import { Marked } from 'marked'

/**
 * Markdown to HTML, in a worker.
 *
 * Off the UI thread for two reasons. A big file — the shell reads up to 8 MB — takes long enough to
 * parse that every terminal would stop scrolling while it did. And a parser can be made to work for
 * ever by a file written to make it; on the UI thread that freezes the whole window with no way
 * out, where here it freezes a worker, which the page puts down when it does not answer.
 *
 * TIME IS NOT THE ONLY THING A FILE CAN BE WRITTEN TO BLOW UP. What it renders to is bounded too,
 * because the page has to sanitise and lay out every byte of it on the UI thread. Two ways a few
 * kilobytes become a hundred megabytes, both measured on this marked: a table whose header names a
 * thousand columns, which pads every one-cell row out to a thousand (15 KB to 2,000,000 cells), and
 * one long link definition referenced over and over, written out in full each time (142 KB to
 * 96 MB). The first is refused before marked builds it; the second runs out of budget mid-render.
 *
 * WHAT COMES OUT IS NOT SAFE TO INSERT. Raw HTML in Markdown passes straight through, as it does on
 * GitHub, and the page sanitises the result before any of it reaches the DOM — which takes a DOM,
 * and a worker has none.
 */

export interface ParseJob {
  id: number
  text: string
}

export type ParseReply = { id: number; html: string } | { id: number; error: string }

/** Heading ids given out so far in the document being parsed, for GitHub's `-1`, `-2` on repeats. */
const slugs = new Map<string, number>()

/** The most HTML a document may render to, in characters, and how much the one being parsed has used. */
const MAX_HTML_CHARS = 16 * 1024 * 1024
let spent = 0

/** Past this many cells a table is not built: it is shown as the text it was written as. */
const MAX_TABLE_CELLS = 100_000

const TOO_BIG = 'This document renders to more than the preview can show.'

/**
 * Count what a renderer is about to write. Leaves only — text, addresses, code — since everything
 * else is a fixed few tags around them; the counted text of a tight list item is counted again as
 * its words, which errs on the side that stops sooner.
 */
function spend(chars: number): void {
  spent += chars
  if (spent > MAX_HTML_CHARS) throw new Error(TOO_BIG)
}

const markdown = new Marked({
  gfm: true,
  tokenizer: {
    // Not a table, rather than a table too big to draw: `undefined` lets the paragraph rule have it.
    table(src) {
      return oversizedTable(src) ? undefined : false
    }
  },
  renderer: {
    heading({ tokens, depth }) {
      const id = slugFor(this.parser.parseInline(tokens, this.parser.textRenderer))
      return `<h${depth}${id ? ` id="${id}"` : ''}>${this.parser.parseInline(tokens)}</h${depth}>\n`
    },
    // `false`: counted, and then drawn by marked's own renderer.
    text(token) {
      if (!('tokens' in token && token.tokens)) spend(token.text.length)
      return false
    },
    link({ href, title }) {
      spend(href.length + (title?.length ?? 0) + 16)
      return false
    },
    image({ href, title, text }) {
      spend(href.length + (title?.length ?? 0) + text.length + 16)
      return false
    },
    codespan({ text }) {
      spend(text.length + 13)
      return false
    },
    code({ text }) {
      spend(text.length + 24)
      return false
    },
    html({ text }) {
      spend(text.length)
      return false
    },
    tablecell() {
      spend(10)
      return false
    }
  }
})

/**
 * Whether the table starting `src` would have more cells than are worth drawing — judged before
 * marked builds it, because building it is the expensive part: every short row is padded to the
 * header's width. Columns are read off the delimiter row and rows counted up to the first blank
 * line, which can only overestimate, and the count stops as soon as the answer is known.
 */
function oversizedTable(src: string): boolean {
  const first = src.indexOf('\n')
  if (first < 0) return false
  const second = src.indexOf('\n', first + 1)
  const delimiter = src.slice(first + 1, second < 0 ? undefined : second)
  if (!/^[\s|:-]+$/.test(delimiter) || !delimiter.includes('-')) return false
  const columns = delimiter.match(/-+/g)?.length ?? 1
  const allowed = Math.floor(MAX_TABLE_CELLS / columns)
  let rows = 0
  for (let at = second; at >= 0; ) {
    const end = src.indexOf('\n', at + 1)
    if (src.slice(at + 1, end < 0 ? undefined : end).trim() === '') return false
    if (++rows > allowed) return true
    at = end
  }
  return false
}

/**
 * GitHub's anchor for a heading, as github-slugger makes it: lower case, punctuation and symbols
 * gone, spaces to hyphens — so `#getting-started` links written for GitHub land here too. Letters
 * in any script survive, which is what keeps a Chinese heading linkable. Nothing that could end an
 * attribute survives, so it goes into one as it is.
 */
function slugFor(text: string): string {
  const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-')
  if (!base) return ''
  let slug = base
  while (slugs.has(slug)) {
    const n = slugs.get(base)! + 1
    slugs.set(base, n)
    slug = `${base}-${n}`
  }
  slugs.set(slug, 0)
  return slug
}

/**
 * YAML between `---` lines at the very top, as Jekyll and Hugo write it — and as every agent's
 * instructions file does. Shown as what it is, a block of YAML, rather than run together into a
 * paragraph and a horizontal rule.
 */
const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

function render(text: string): string {
  slugs.clear()
  spent = 0
  const front = FRONT_MATTER.exec(text)
  const body = front ? text.slice(front[0].length) : text
  const html = markdown.parse(body, { async: false })
  // What the counting above does not see — tags, and whatever else marked adds — checked once, whole.
  if (html.length > MAX_HTML_CHARS) throw new Error(TOO_BIG)
  if (!front) return html
  return `<div class="markdown-frontmatter"><pre><code class="language-yaml">${escape(front[1]!)}\n</code></pre></div>\n${html}`
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

self.onmessage = (event: MessageEvent<ParseJob>) => {
  const { id, text } = event.data
  let reply: ParseReply
  try {
    reply = { id, html: render(text) }
  } catch (err) {
    // Nesting a few thousand deep — `>>>>…` — runs the parser's recursion out of stack. Anything
    // else comes back as said, less the line marked adds asking for a bug report about it.
    const message =
      err instanceof RangeError ? 'This document is nested too deeply to render.'
      : err instanceof Error ? err.message.replace(/\nPlease report this to https:\/\/github\.com\/markedjs\/marked\.$/, '')
      : String(err)
    reply = { id, error: message }
  }
  self.postMessage(reply)
}
