import { markdownClient, type MarkdownCall } from '../protocol'

/**
 * The plugin's own line to main, reachable from a component, and the state the previews share.
 *
 * Components cannot hold `ctx` — a cordis service access costs microseconds per property read — so
 * the renderer entry captures `ctx.rpc.invoke` once at activation and parks the typed client here,
 * through `ctx.effect`: disposing the plugin unparks it.
 */
let live: MarkdownCall | null = null

export function connect(invoke: (command: string, args: unknown) => Promise<unknown>): () => void {
  live = markdownClient(invoke)
  return () => { live = null }
}

export const markdown: MarkdownCall = (command, args) => {
  if (!live) return Promise.reject(new Error(`the Markdown preview is not active, cannot ${command}`))
  return live(command, args)
}

/**
 * Which previews want to hear about which file. Main is told the whole set whenever its keys change,
 * never a delta — so a reload of the renderer, which forgets everything, is put right by the next
 * preview to mount rather than leaving watchers nobody will ever stop.
 */
const watchers = new Map<string, Set<() => void>>()
let telling = false

/** Call `onChange` whenever `path` changes on disk, until the returned undo. */
export function watchFile(path: string, onChange: () => void): () => void {
  let set = watchers.get(path)
  if (!set) {
    watchers.set(path, (set = new Set()))
    tell()
  }
  set.add(onChange)
  return () => {
    set.delete(onChange)
    if (set.size > 0 || watchers.get(path) !== set) return
    watchers.delete(path)
    tell()
  }
}

/** From main: a watched file changed. */
export function fileChanged(path: string): void {
  for (const onChange of watchers.get(path) ?? []) onChange()
}

/**
 * Once per turn at most. Opening a tab mounts, unmounts and mounts again under StrictMode, and three
 * IPC calls saying the same thing are two too many.
 */
function tell(): void {
  if (telling) return
  telling = true
  queueMicrotask(() => {
    telling = false
    void markdown('markdown:watch', { paths: [...watchers.keys()] }).catch((e: unknown) =>
      console.warn('[markdown] cannot watch files', e)
    )
  })
}

/**
 * Anchors waiting for a preview to draw. A link to `guide.md#setup` opens that file's preview first,
 * and it can only scroll to the heading once it has one; a request for a preview already on screen
 * is handed straight over.
 */
const anchorWaiting = new Map<string, string>()
const anchorListeners = new Map<string, (fragment: string) => void>()

export function requestAnchor(tabId: string, fragment: string): void {
  const listener = anchorListeners.get(tabId)
  if (listener) listener(fragment)
  else anchorWaiting.set(tabId, fragment)
}

export function onAnchor(tabId: string, listener: (fragment: string) => void): () => void {
  anchorListeners.set(tabId, listener)
  const waiting = anchorWaiting.get(tabId)
  if (waiting !== undefined) {
    anchorWaiting.delete(tabId)
    listener(waiting)
  }
  return () => {
    if (anchorListeners.get(tabId) === listener) anchorListeners.delete(tabId)
  }
}
