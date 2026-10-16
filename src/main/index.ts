import { net } from 'electron'
import { constants, existsSync, watch, type FSWatcher } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute } from 'node:path'
import type { Context, Plugin } from 'cordis'
import { markdownEmitter, registerMarkdownCommands, type MarkdownImage } from '../protocol'

/**
 * The Markdown preview's main half: it watches the files previews are open on, and fetches the
 * pictures they show. The text itself is read through the shell, like any other viewer's.
 *
 * One `fs.watch` per FOLDER, never per file, and never recursive. A watch on the file itself goes
 * deaf at the first atomic save — an editor writes a temporary file and renames it over the old
 * one, the inode the watch was on is gone, and nothing is ever reported again. The folder outlives
 * that, and names the file in each event. Not @parcel/watcher, as the explorer uses: it only
 * watches recursively, and a preview of the README at the root of a checkout has no business
 * watching everything underneath it.
 *
 * `inject` is not optional: reading `ctx.commands` or `ctx.shell` without declaring it throws, and
 * a half whose injection cannot be satisfied sits in PENDING with `apply` never running.
 */

/** A save is several events — a write, a rename, a chmod — and they settle into one: trailing, with a ceiling. */
const SETTLE_MS = 60
/** So a file an agent is still writing, which never settles, is redrawn as it grows rather than once at the end. */
const MAX_WAIT_MS = 500

/** Past any screenshot or diagram; what is bigger than this is not an illustration. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
/** A badge is a kilobyte. A picture on the web bigger than this is not worth the wait. */
const MAX_REMOTE_BYTES = 10 * 1024 * 1024
const REMOTE_TIMEOUT_MS = 15_000

/** Named from the extension, so the Blob says what it holds. SVG is safe here: an <img> runs no script. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.pjpeg': 'image/jpeg',
  '.pjp': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.cur': 'image/x-icon',
  '.svg': 'image/svg+xml'
}

/**
 * How often a folder that has gone is looked for again. A checkout of a branch without it, and back,
 * takes it away and puts it back, and the previews of the files in it should come back with it.
 */
const SEEK_MS = 1000

interface Folder {
  /** Null while the folder is not there to watch. */
  watcher: FSWatcher | null
  /** Making sure, once a burst of events has settled, that the folder is still there. */
  verifying: NodeJS.Timeout | null
  /** Looking for the folder again, while it is gone. */
  seeking: NodeJS.Timeout | null
  /** The watched files in it: name as events report it, to path as the renderer spelled it. */
  files: Map<string, string>
}

interface Pending {
  timer: NodeJS.Timeout
  ceiling: NodeJS.Timeout
}

const plugin: Plugin = {
  name: 'markdown',
  inject: ['commands', 'shell'],
  apply(ctx: Context) {
    // Bound at activation: a detached cordis service method has no `this` (see @rigee/plugin-api's
    // context.ts).
    const commands = ctx.commands
    const register = commands.register.bind(commands)
    const shell = ctx.shell
    const emit = markdownEmitter(shell.emit.bind(shell))

    const folders = new Map<string, Folder>()
    const pending = new Map<string, Pending>()
    let disposed = false

    const flush = (path: string): void => {
      const p = pending.get(path)
      if (!p) return
      clearTimeout(p.timer)
      clearTimeout(p.ceiling)
      pending.delete(path)
      emit('changed', { path })
    }

    const changed = (path: string): void => {
      const p = pending.get(path)
      if (p) {
        clearTimeout(p.timer)
        p.timer = setTimeout(flush, SETTLE_MS, path)
        return
      }
      pending.set(path, { timer: setTimeout(flush, SETTLE_MS, path), ceiling: setTimeout(flush, MAX_WAIT_MS, path) })
    }

    /** Every watched file in the folder may have changed: the folder itself went, or came back. */
    const everything = (folder: Folder): void => {
      for (const path of folder.files.values()) changed(path)
    }

    /** Watch the folder. False when it cannot be — it is not there, or not now. */
    const arm = (dir: string, folder: Folder): boolean => {
      try {
        const watcher = watch(dir, { persistent: false }, (_event, name) => {
          if (folders.get(dir) !== folder) return
          // No name: the platform could not say which entry it was (Linux, now and then), so any of
          // ours may have changed.
          if (name === null) everything(folder)
          else {
            const path = folder.files.get(name)
            if (path) changed(path)
          }
          verify(dir, folder)
        })
        watcher.on('error', () => { lost(dir, folder) })
        folder.watcher = watcher
        return true
      } catch {
        return false
      }
    }

    /**
     * After any event, once the burst has settled: is the folder still there? Deleting it is not
     * reported as deleting the files in it — on macOS, measured, `rm -rf` gives one `change` naming
     * the folder itself and nothing for the files; on Linux the files' deletions come first and the
     * watch then dies with the folder, silently. Either way the folder's absence is the news.
     */
    const verify = (dir: string, folder: Folder): void => {
      if (folder.verifying) clearTimeout(folder.verifying)
      folder.verifying = setTimeout(() => {
        folder.verifying = null
        if (folders.get(dir) === folder && folder.watcher && !existsSync(dir)) lost(dir, folder)
      }, SETTLE_MS)
    }

    /** The folder went — deleted, renamed away, unmounted. Its previews are told, and it is looked for. */
    const lost = (dir: string, folder: Folder): void => {
      folder.watcher?.close()
      folder.watcher = null
      everything(folder)
      seek(dir, folder)
    }

    const seek = (dir: string, folder: Folder): void => {
      if (folder.seeking || disposed) return
      folder.seeking = setTimeout(() => {
        folder.seeking = null
        if (folders.get(dir) !== folder || disposed) return
        // Back: watched again, and its previews read their files, which may have come back with it.
        if (existsSync(dir) && arm(dir, folder)) everything(folder)
        else seek(dir, folder)
      }, SEEK_MS)
    }

    const unwatch = (dir: string): void => {
      const folder = folders.get(dir)
      folders.delete(dir)
      folder?.watcher?.close()
      if (folder?.verifying) clearTimeout(folder.verifying)
      if (folder?.seeking) clearTimeout(folder.seeking)
    }

    const watchFiles = (paths: string[]): void => {
      const wanted = new Map<string, Map<string, string>>()
      for (const path of paths) {
        const dir = dirname(path)
        let files = wanted.get(dir)
        if (!files) wanted.set(dir, (files = new Map()))
        files.set(basename(path), path)
      }
      for (const dir of [...folders.keys()]) if (!wanted.has(dir)) unwatch(dir)

      for (const [dir, files] of wanted) {
        const known = folders.get(dir)
        if (known) {
          known.files = files
          continue
        }
        const folder: Folder = { watcher: null, verifying: null, seeking: null, files }
        folders.set(dir, folder)
        // Not there: the preview is already saying so, and the folder is looked for until it is.
        if (!arm(dir, folder)) seek(dir, folder)
      }
    }

    ctx.effect(() => () => {
      disposed = true
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        clearTimeout(p.ceiling)
      }
      pending.clear()
      for (const dir of [...folders.keys()]) unwatch(dir)
    }, 'markdown watchers')

    registerMarkdownCommands(register, {
      'markdown:watch': ({ paths }) => { watchFiles(paths.filter(Boolean)) },
      'markdown:image': ({ path }) => readPicture(path),
      'markdown:remoteImage': ({ url }) => fetchPicture(url)
    })
  }
}

export default plugin

/**
 * A picture on disk, named by a document — so by somebody else, as far as main can tell.
 *
 * Opened first and measured through the handle, so the thing measured is the thing read. Only a
 * regular file with something in it: a device or a pipe has no size and no end, and `logo.png`
 * checked into a repository as a symlink to /dev/zero would otherwise be read until main ran out
 * of memory, taking every terminal with it. O_NONBLOCK so that a FIFO under a picture's name cannot
 * hang the open itself. Never a sync read: main is shared, and a long one stalls every terminal.
 */
async function readPicture(path: string): Promise<MarkdownImage> {
  const mime = IMAGE_MIME[extname(path).toLowerCase()]
  if (!mime) throw new Error(`${basename(path)} is not a picture`)
  if (!isAbsolute(path)) throw new Error(`${path} is not a path on this computer`)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const info = await handle.stat()
    const size = info.size
    if (!info.isFile() || size === 0) throw new Error(`${basename(path)} is not a picture`)
    if (size > MAX_IMAGE_BYTES) throw new Error(`${basename(path)} is ${mib(size)} MiB, past the ${mib(MAX_IMAGE_BYTES)} MiB limit`)
    const bytes = new Uint8Array(size)
    let filled = 0
    while (filled < size) {
      const { bytesRead } = await handle.read(bytes, filled, size - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    // Shorter than it said: it shrank while being read. What arrived is all there is.
    return { bytes: filled === size ? bytes : bytes.slice(0, filled), mime }
  } finally {
    await handle.close()
  }
}

/**
 * A picture from the web, read with a running count: Content-Length can be missing or wrong, and a
 * server that streams forever must not be able to fill the heap.
 */
async function fetchPicture(url: string): Promise<MarkdownImage> {
  const target = new URL(url)
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error(`not a web address: ${url}`)
  // No cookies, and nothing to say where it was linked from: a picture in a README is not a login.
  const response = await net.fetch(target.href, { credentials: 'omit', signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${target.host} answered ${response.status}`)
  const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!mime.startsWith('image/')) throw new Error(`${target.host} did not answer with a picture`)
  if (!response.body) throw new Error(`${target.host} sent nothing`)

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_REMOTE_BYTES) {
      await reader.cancel()
      throw new Error(`${target.host} sent more than ${mib(MAX_REMOTE_BYTES)} MiB`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, mime }
}

function mib(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}
