import DOMPurify from 'dompurify'

/**
 * What of a rendered document may reach the page: GitHub's allowlist, give or take.
 *
 * THE ONE BOUNDARY IN THIS PLUGIN THAT MATTERS. The preview is drawn into the shell's own document,
 * where `window.rigee` can start programs; a README in a repository cloned a minute ago is somebody
 * else's HTML. So it gets what GitHub would let it have — nothing that runs, nothing that loads
 * without asking, nothing that styles — and the rules are enforced here, on the way in, rather than
 * hoped for downstream:
 *
 *   tags and attributes   an allowlist. No script, style, iframe, form or SVG; no `style`, no
 *                         `on*`, no `data-*`. URLs are checked by DOMPurify: no `javascript:`.
 *   class                 only the ones this plugin writes. Any other could be one of the shell's
 *                         own, and borrow its look — a dialog, a menu — from inside a document.
 *   id, name              prefixed `user-content-`, as GitHub does, so that `<a name="rigee">`
 *                         cannot shadow a global through the browser's named-element lookup.
 *   img src               moved aside before the node can reach the page, where it would be
 *                         fetched at once. The preview decides how each picture is loaded.
 *
 * Its own DOMPurify instance, so these hooks touch no other copy in the window.
 */

const purify = DOMPurify(window)

const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q',
  'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr'
]

const ALLOWED_ATTR = [
  'align', 'alt', 'checked', 'cite', 'class', 'colspan', 'datetime', 'dir', 'disabled', 'height',
  'href', 'id', 'lang', 'name', 'open', 'reversed', 'rowspan', 'scope', 'span', 'src', 'start',
  'title', 'type', 'valign', 'width'
]

/** What the parser writes: a fenced block's language, and the front matter's box. */
const OWN_CLASS = /^(?:language-[\w#+.-]+|markdown-frontmatter)$/

/** Where an `<img>`'s address waits for the preview to decide how to load it. */
export const IMAGE_SOURCE = 'data-markdown-src'

purify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName !== 'class') return
  data.attrValue = data.attrValue.split(/\s+/).filter((name) => OWN_CLASS.test(name)).join(' ')
  if (!data.attrValue) data.keepAttr = false
})

purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName === 'IMG') {
    const src = node.getAttribute('src')
    node.removeAttribute('src')
    if (src) node.setAttribute(IMAGE_SOURCE, src)
  } else if (node.nodeName === 'INPUT') {
    // A task list's box, and one that cannot be ticked: whatever <input> the HTML wrote, this is
    // all it becomes.
    node.setAttribute('type', 'checkbox')
    node.setAttribute('disabled', '')
  }
})

/** The parser's HTML, made safe, as nodes not yet in any page. */
export function sanitize(html: string): DocumentFragment {
  return purify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    SANITIZE_NAMED_PROPS: true,
    RETURN_DOM_FRAGMENT: true
  })
}

/** The prefix `SANITIZE_NAMED_PROPS` gives every id, which an `#anchor` has to be looked up under. */
export const ID_PREFIX = 'user-content-'

const ALERTS: Record<string, string> = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution'
}

/**
 * What GitHub adds to the HTML after it is safe, done here for the same reason: the classes below
 * are this plugin's, set on nodes it has already vetted.
 *
 *   alerts      `> [!NOTE]` and its four siblings — a blockquote whose first line is the marker —
 *               drawn as callouts, with the marker replaced by a title.
 *   link title  the address, on hover, for a link that did not give one: there is no status bar to
 *               say where a link goes before it is clicked.
 */
export function decorate(root: ParentNode): void {
  for (const quote of root.querySelectorAll('blockquote')) {
    const first = quote.firstElementChild
    const lead = first?.tagName === 'P' ? first.firstChild : null
    if (!first || lead?.nodeType !== Node.TEXT_NODE) continue
    const marker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i.exec(lead.textContent ?? '')
    if (!marker) continue
    const kind = marker[1]!.toUpperCase()
    lead.textContent = lead.textContent!.slice(marker[0].length)
    // The marker had a paragraph to itself: drop the paragraph too.
    if (!first.textContent?.trim() && !first.querySelector('img')) first.remove()
    const title = document.createElement('p')
    title.className = 'markdown-alert__title'
    title.textContent = ALERTS[kind]!
    quote.classList.add('markdown-alert', `markdown-alert--${kind.toLowerCase()}`)
    quote.prepend(title)
  }
  for (const link of root.querySelectorAll('a[href]:not([title])')) {
    link.setAttribute('title', link.getAttribute('href')!)
  }
}
