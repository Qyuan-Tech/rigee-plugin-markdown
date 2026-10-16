import { tokenizeCode, type CodeToken } from '@rigee/plugin-api'

/**
 * Colour for fenced code blocks, from the text editor's own tokenizers, lent out by Rigee through
 * `tokenizeCode`.
 *
 * Not a highlighter of our own: Rigee's editor knows every language it does by the same names, and
 * its tokenizers are very likely loaded already. They are still asked for only once a document has
 * a block that names a language, so a plain note never costs their megabytes.
 *
 * Tokens, NOT coloured HTML, build what goes on the page. HTML from the editor writes every space as
 * a no-break space and expands tabs, so code copied out of the preview and pasted into a terminal
 * would not be the code that was written. Here each token is a span around the exact text, and the
 * colours are this file's stylesheet's — the editor theme's, by value.
 */

/** Past these a block stays plain: tokenising runs on the UI thread, a line at a time. */
const MAX_BLOCK_CHARS = 100_000
const MAX_DOCUMENT_CHARS = 400_000

/** Fence names the editor knows by no id, alias or extension of its own. */
const FENCE_NAMES: Record<string, string> = {
  zsh: 'shell',
  console: 'shell',
  'shell-session': 'shell',
  terminal: 'shell',
  jsonc: 'json',
  json5: 'json',
  golang: 'go',
  'c++': 'cpp',
  'c#': 'csharp',
  docker: 'dockerfile'
}

/** Fence names the editor does not know, even through FENCE_NAMES. Remembered: a document says `txt` forty times. */
const unknown = new Set<string>()

/**
 * Colour every block under `root` that names a language the editor has. Stops as soon as `live`
 * says the document it was asked about has been replaced.
 */
export async function highlight(root: ParentNode, live: () => boolean): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')]
  if (blocks.length === 0) return
  let budget = MAX_DOCUMENT_CHARS
  for (const code of blocks) {
    if (!live()) return
    const name = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1]?.toLowerCase()
    const text = code.textContent ?? ''
    if (!name || unknown.has(name) || text.length > MAX_BLOCK_CHARS || text.length > budget) continue
    const lines = await tokens(text, name)
    if (!live() || !code.isConnected) return
    if (!lines) continue
    // Charged only for what was tokenised: a block in a language nobody knows cost nothing.
    budget -= text.length
    code.replaceChildren(paint(text, lines))
  }
}

/** The editor's tokens for `text` in the language a fence names, or null when it knows none. */
async function tokens(text: string, name: string): Promise<CodeToken[][] | null> {
  const direct = await tokenizeCode(text, name)
  if (direct) return direct
  const alias = FENCE_NAMES[name]
  const aliased = alias ? await tokenizeCode(text, alias) : null
  if (!aliased) unknown.add(name)
  return aliased
}

/** The block's own text, cut at the token boundaries. Lines come back joined exactly as they were. */
function paint(text: string, lines: CodeToken[][]): DocumentFragment {
  const out = document.createDocumentFragment()
  text.split('\n').forEach((line, i) => {
    if (i > 0) out.append('\n')
    const tokens = lines[i] ?? []
    const start = tokens[0]?.offset ?? line.length
    if (start > 0) out.append(line.slice(0, start))
    tokens.forEach((token, t) => {
      const piece = line.slice(token.offset, tokens[t + 1]?.offset ?? line.length)
      if (!piece) return
      const kind = tokenClass(token.type)
      if (!kind) {
        out.append(piece)
        return
      }
      const span = document.createElement('span')
      span.className = kind
      span.textContent = piece
      out.append(span)
    })
  })
  return out
}

/**
 * A Monarch token type — `keyword.ts`, `string.escape.js`, `attribute.value.html` — to the class
 * that colours it. The kind is the first segment; the language is the last and does not matter.
 */
function tokenClass(type: string): string | null {
  const [kind, sub] = type.split('.')
  switch (kind) {
    case 'comment':
      return 'tok-comment'
    case 'string':
      return sub === 'escape' ? 'tok-escape' : 'tok-string'
    case 'regexp':
      return 'tok-regexp'
    case 'keyword':
    case 'annotation':
      return 'tok-keyword'
    case 'number':
    case 'constant':
      return 'tok-number'
    case 'type':
      return 'tok-type'
    case 'tag':
    case 'metatag':
      return 'tok-tag'
    case 'attribute':
      return sub === 'value' ? 'tok-string' : 'tok-attribute'
    case 'key':
      return 'tok-attribute'
    case 'variable':
    case 'predefined':
      return 'tok-variable'
    case 'delimiter':
    case 'operator':
      return 'tok-punctuation'
    case 'invalid':
      return 'tok-invalid'
    case 'emphasis':
      return 'tok-emphasis'
    case 'strong':
      return 'tok-strong'
    default:
      return null
  }
}
