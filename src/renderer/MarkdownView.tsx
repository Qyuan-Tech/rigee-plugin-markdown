import { duplicatedFrom, Notice, openFile, readFile, useActiveWorkspace } from '@rigee/plugin-api'
import { useEffect, useRef, useState } from 'react'
import { PREVIEW_VIEW } from '../names'
import { highlight } from './highlight'
import { remember, release, type Picture } from './memory'
import { parseMarkdown } from './parse'
import { basename, isMarkdownPath, localTarget, rootFor, samePath } from './paths'
import { markdown, onAnchor, requestAnchor, watchFile } from './rpc'
import { decorate, ID_PREFIX, IMAGE_SOURCE, sanitize } from './sanitize'
import type { PluginEditorProps, TextSelection } from '@rigee/plugin-api'
import type { MarkdownImage } from '../protocol'
import './markdown.css'

/**
 * The preview pane: a toolbar, and the document as it reads.
 *
 * The file is read through the shell, parsed in a worker, sanitised, and put into the page as nodes
 * — never as a string handed to innerHTML. It is drawn again whenever main says the file changed,
 * keeping the reader's place, so a plan an agent is writing can be watched as it grows.
 *
 * EVERY CLICK ON A LINK IS CANCELLED AND DECIDED HERE. Followed by the page, a link would navigate
 * the shell's own window — the whole app — away to wherever it pointed.
 */

/**
 * How long a first drawing waits for its pictures before putting the reader where they were going
 * for the second time. Ones on disk take milliseconds; this is for the one that never comes.
 */
const SETTLE_LIMIT_MS = 2000

interface Shown {
  /** The bytes were not UTF-8, so what is on screen is a best-effort decoding. */
  notUtf8: boolean
  empty: boolean
  /** Pictures on the web, held back until the reader asks for them. */
  held: number
}

export function MarkdownView({ filePath, tabId }: PluginEditorProps): React.ReactElement {
  const scroller = useRef<HTMLDivElement>(null)
  const article = useRef<HTMLElement>(null)
  const [shown, setShown] = useState<Shown | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Bumped when the file changes on disk, and by Reload. */
  const [version, setVersion] = useState(0)
  const root = rootFor(filePath, useActiveWorkspace())
  /**
   * What this tab remembers from its last mount — or, for a split copy, what the tab it was split
   * from does. Asked once: the origin is consumed, and asking twice finds the memory already made.
   */
  const [memory] = useState(() => remember(tabId, duplicatedFrom(tabId)))
  /** Where to scroll once the document is first on the page. */
  const [start] = useState(() => memory.position)
  const [remote, setRemote] = useState(() => memory.remote)
  /** Whether the document has been on the page yet, and an anchor asked for before it was. */
  const drawn = useRef(false)
  const anchor = useRef<string | null>(null)
  /**
   * While the first drawing's pictures are still arriving: its place is put back once they have,
   * and scrolling meanwhile — the page growing under it — is not taken for where the reader is.
   * Ends early if the reader takes over.
   */
  const settling = useRef(false)
  /** Pictures a Reload replaced, let go once the document drawn without them is on the page. */
  const retired = useRef<Picture[]>([])

  useEffect(() => {
    const old = retired
    return () => { for (const picture of old.current.splice(0)) release(picture) }
  }, [])

  useEffect(() => watchFile(filePath, () => setVersion((v) => v + 1)), [filePath])

  useEffect(
    () =>
      onAnchor(tabId, (fragment) => {
        if (drawn.current && scroller.current && article.current) scrollToAnchor(scroller.current, article.current, fragment)
        else anchor.current = fragment
      }),
    [tabId]
  )

  useEffect(() => {
    let current = true
    const live = (): boolean => current
    void (async () => {
      try {
        const file = await readFile(filePath)
        if (!current) return
        if (file.tooLarge) throw new Error(`${basename(filePath)} is too large to preview.`)
        const html = await parseMarkdown(tabId, file.content)
        const page = article.current
        if (!current || !page) return

        const doc = sanitize(html)
        decorate(doc)
        page.replaceChildren(doc)
        for (const picture of retired.current.splice(0)) release(picture)
        const { held, pending } = showPictures(page, { file: filePath, root, remote, pictures: memory.pictures, live })
        setError(null)
        setShown({ notUtf8: file.notUtf8 === true, empty: file.content.trim() === '', held })

        if (!drawn.current) {
          drawn.current = true
          const waiting = anchor.current
          anchor.current = null
          const place = (): void => {
            if (!scroller.current || !article.current) return
            if (waiting === null) scroller.current.scrollTop = start
            else scrollToAnchor(scroller.current, article.current, waiting)
          }
          place()
          // Pictures still arriving push down everything below them. Put the reader where they were
          // going once those have come — or given up — unless the reader has moved on first.
          if (pending.length > 0 && (waiting !== null || start > 0)) {
            settling.current = true
            void Promise.race([Promise.allSettled(pending), delay(SETTLE_LIMIT_MS)]).then(() => {
              if (settling.current) place()
              settling.current = false
            })
          }
        }
        // Colour is a nicety: a block it fails on stays plain, and the document is still the document.
        void highlight(page, live).catch((e: unknown) => console.warn('[markdown] cannot colour code blocks', e))
      } catch (e) {
        if (current) setError(problem(e, filePath))
      }
    })()
    return () => { current = false }
  }, [filePath, version, root, remote, start, tabId, memory])

  /** Where a link goes. Only somewhere this decides: another preview, the editor, or the system browser. */
  const follow = (href: string): void => {
    if (/^(?:https?|mailto):/i.test(href)) {
      // The shell hands every window.open to the system browser, which is the one place a link
      // from a document may take the reader out of the app.
      window.open(href)
      return
    }
    const target = localTarget(href, filePath, root)
    if (!target) return
    if (isMarkdownPath(target.path)) {
      if (samePath(target.path, filePath)) {
        if (scroller.current && article.current) scrollToAnchor(scroller.current, article.current, target.fragment)
        return
      }
      const opened = openFile({ path: target.path, viewType: PREVIEW_VIEW, nearTabId: tabId })
      if (opened && target.fragment) requestAnchor(opened, target.fragment)
      return
    }
    openFile({ path: target.path, nearTabId: tabId, selection: lineOf(target.fragment) })
  }

  const reload = (): void => {
    retired.current.push(...memory.pictures.values())
    memory.pictures.clear()
    setVersion((v) => v + 1)
  }

  /** The reader scrolled, clicked or pressed a key in the document: where they are is theirs now. */
  const takeOver = (): void => { settling.current = false }

  const where =
    root && (filePath.startsWith(root + '/') || filePath.startsWith(root + '\\')) ? filePath.slice(root.length + 1) : filePath
  /** Nothing to read: the file could not be, or there is nothing in it. A notice takes the pane. */
  const blank = error !== null || shown?.empty === true

  return (
    <div className="markdown">
      <div className="markdown__bar">
        <span className="markdown__where" title={filePath}>{where}</span>
        {shown?.notUtf8 && (
          <span className="markdown__note" title="The file is not UTF-8; what is shown is a best-effort decoding of it.">
            Not UTF-8
          </span>
        )}
        <span className="markdown__spacer" />
        {!remote && shown && shown.held > 0 && (
          <button
            className="btn"
            title="Fetch the pictures this document shows from the web. Until then nothing is requested from anywhere."
            onClick={() => {
              memory.remote = true
              setRemote(true)
            }}
          >
            Show remote images
          </button>
        )}
        <button className="btn" title="Open the file in the editor" onClick={() => openFile({ path: filePath, nearTabId: tabId })}>
          Edit
        </button>
        <button className="btn" title="Read the file, and its pictures, again" onClick={reload}>
          Reload
        </button>
      </div>

      <div className="markdown__body">
        <div
          ref={scroller}
          className="markdown__scroller"
          hidden={blank}
          // Focusable, so the arrow keys, Page Up and Space scroll once the document has been clicked.
          tabIndex={0}
          onScroll={(e) => { if (!settling.current) memory.position = e.currentTarget.scrollTop }}
          onWheel={takeOver}
          onPointerDown={takeOver}
          onKeyDown={(e) => {
            takeOver()
            // Select All means this document, not every bit of selectable text in the window.
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a' && article.current) {
              e.preventDefault()
              window.getSelection()?.selectAllChildren(article.current)
            }
          }}
        >
          <article
            ref={article}
            className="markdown__doc"
            onClick={(e) => {
              const link = (e.target as Element).closest('a')
              if (!link || !e.currentTarget.contains(link)) return
              e.preventDefault()
              const href = link.getAttribute('href')
              if (href) follow(href)
            }}
            // A middle click on a link would open it as a new window — which the shell would hand
            // to the system browser, resolved against the app's own address rather than the file.
            onAuxClick={(e) => { if ((e.target as Element).closest('a')) e.preventDefault() }}
          />
        </div>
        {blank && (error === null ? <Notice>{basename(filePath)} is empty.</Notice> : <Notice tone="error">{error}</Notice>)}
      </div>
    </div>
  )
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

interface PictureContext {
  file: string
  root: string | null
  remote: boolean
  pictures: Map<string, Picture>
  live: () => boolean
}

/**
 * Give each picture its bytes, as a blob: URL — the page's CSP lets an <img> load from nowhere
 * else, the disk included. Ones on disk are read by main. Ones on the web wait until the reader
 * asks, standing in as their alt text meanwhile, and are counted so the toolbar can offer them.
 * Also says which pictures are still on their way, for a first drawing to wait on.
 */
function showPictures(page: HTMLElement, cx: PictureContext): { held: number; pending: Promise<unknown>[] } {
  let held = 0
  const pending: Promise<unknown>[] = []
  for (const img of page.querySelectorAll<HTMLImageElement>(`img[${IMAGE_SOURCE}]`)) {
    const src = img.getAttribute(IMAGE_SOURCE)!
    // Hidden until it has something to show: an <img> with alt text and no src draws the text.
    img.hidden = true
    if (/^data:/i.test(src)) {
      reveal(img, src)
      continue
    }

    let key: string
    let load: () => Promise<MarkdownImage>
    if (/^https?:/i.test(src) || src.startsWith('//')) {
      const url = src.startsWith('//') ? `https:${src}` : src
      if (!cx.remote) {
        held++
        standIn(img, `A picture from ${hostOf(url)}, not loaded. Show remote images to load it.`)
        continue
      }
      key = url
      load = () => markdown('markdown:remoteImage', { url })
    } else {
      const target = localTarget(src, cx.file, cx.root)
      if (!target) {
        standIn(img, `${src} is not somewhere this preview can load a picture from.`)
        continue
      }
      key = target.path
      load = () => markdown('markdown:image', { path: target.path })
    }

    const fetch = (failedBefore?: string): Picture => {
      const made: Picture = {
        url: load().then((p) => URL.createObjectURL(new Blob([p.bytes], { type: p.mime }))),
        failed: failedBefore,
        settled: false
      }
      made.url.then(
        (u) => Object.assign(made, { ready: u, failed: undefined, settled: true }),
        (e: unknown) => Object.assign(made, { failed: pictureProblem(e, key), settled: true })
      )
      cx.pictures.set(key, made)
      return made
    }
    const show = (picture: Picture): void => {
      picture.url.then(
        (u) => { if (cx.live()) reveal(img, u) },
        () => { if (cx.live()) standIn(img, picture.failed ?? 'This picture could not be loaded.') }
      )
    }

    // Everything already known is drawn in the same task as the document, so the page is laid out
    // at its real shape from the first frame and a redraw while an agent writes the file — or coming
    // back to the tab — cannot move what the reader is looking at.
    const known = cx.pictures.get(key)
    if (known?.ready) {
      reveal(img, known.ready)
      continue
    }
    if (known?.failed !== undefined) {
      // Stands in where it stood, at once — and is asked for again behind that, unless it already
      // is, so a picture an agent writes after the document that shows it turns up the next time
      // the document changes.
      standIn(img, known.failed)
      show(known.settled ? fetch(known.failed) : known)
      continue
    }
    const picture = known ?? fetch()
    pending.push(picture.url)
    show(picture)
  }
  return { held, pending }
}

/** Why a picture could not be had, in words for the usual reason. */
function pictureProblem(e: unknown, key: string): string {
  const why = reasonOf(e)
  return why.startsWith('ENOENT') ? `${basename(key)} was not found.` : why
}

/** A picture that is not shown: its alt text in a box in its place, saying why on hover. */
function standIn(img: HTMLImageElement, why: string): void {
  img.hidden = true
  let box = img.previousElementSibling
  if (!box?.classList.contains('markdown-image')) {
    box = document.createElement('span')
    box.className = 'markdown-image'
    img.before(box)
  }
  box.textContent = img.alt || 'Picture'
  box.setAttribute('title', why)
}

function reveal(img: HTMLImageElement, url: string): void {
  const box = img.previousElementSibling
  if (box?.classList.contains('markdown-image')) box.remove()
  // Bytes Chromium cannot draw — a TIFF, a page served as image/png — stand in as text too, rather
  // than as the broken-picture glyph.
  img.onerror = () => { standIn(img, 'This picture could not be drawn.') }
  img.src = url
  img.hidden = false
}

/**
 * Scroll so the heading or named element `fragment` names is at the top. Looked up under the prefix
 * the sanitiser gave every id, and lower-cased if need be, as GitHub forgives `#Setup` for `#setup`.
 * An anchor that names nothing leaves the reader where they are.
 */
function scrollToAnchor(scroller: HTMLElement, page: HTMLElement, fragment: string): void {
  if (fragment === '' || fragment.toLowerCase() === 'top') {
    scroller.scrollTop = 0
    return
  }
  const target = named(page, fragment) ?? named(page, fragment.toLowerCase())
  if (!target) return
  scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12
}

function named(page: HTMLElement, name: string): Element | null {
  const id = CSS.escape(ID_PREFIX + name)
  return page.querySelector(`#${id}, [name="${id}"]`)
}

/** GitHub's `#L12` and `#L12-L20`: where to put the cursor in a file a link opens in the editor. */
function lineOf(fragment: string): TextSelection | undefined {
  const match = /^L(\d+)(?:C(\d+))?(?:-L\d+(?:C\d+)?)?$/i.exec(fragment)
  return match ? { line: Number(match[1]), column: Number(match[2] ?? 1) } : undefined
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Main's reason, without what the trip over IPC wraps round it: Electron's preamble, and the names
 * of the channel and command it came back through — `fs:readFile: `, `plugin:invoke: markdown:image: `.
 */
function reasonOf(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.replace(/^(?:Error invoking remote method '[^']*': )?(?:Error: )?(?:[\w-]+:[\w-]+: )*/, '')
}

/** The same, in words for the usual one: a file deleted, or renamed by an agent, since the preview opened. */
function problem(e: unknown, path: string): string {
  const reason = reasonOf(e)
  return reason.startsWith('ENOENT') ? `${basename(path)} is no longer there.` : reason
}
