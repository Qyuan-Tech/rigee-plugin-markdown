/**
 * What the Markdown preview's two halves say to each other: which files to watch, the pictures a
 * document shows, and the news that a watched file changed. Parsing and drawing are the renderer's.
 *
 * REALM-FREE, like every protocol.ts: compiled into both the node project and the web project, so
 * types and the small typed wrappers only — no node:*, no DOM.
 */

/** A picture a document shows, read off disk or fetched, ready to go into a Blob. */
export interface MarkdownImage {
  /** Over a plain ArrayBuffer, never a shared one: it goes straight into a Blob. */
  bytes: Uint8Array<ArrayBuffer>
  mime: string
}

export interface MarkdownCommands {
  /**
   * Watch exactly these files — every one a preview is open on — replacing whatever was watched
   * before. An empty list stops watching.
   */
  'markdown:watch': (args: { paths: string[] }) => void
  /** A picture on disk. Rejects for one that is missing, too big, or not a picture at all. */
  'markdown:image': (args: { path: string }) => MarkdownImage
  /**
   * A picture on the web, which the user has just asked to see. Rejects for anything that is not
   * http(s), does not answer with a picture, or is too big.
   */
  'markdown:remoteImage': (args: { url: string }) => MarkdownImage
}

/** Pushes from main. Plugin-local names: the envelope carries the plugin id. */
export interface MarkdownEvents {
  /** A watched file was written, replaced or deleted, spelled as it was given to `markdown:watch`. */
  changed: { path: string }
}

export type MarkdownCommand = keyof MarkdownCommands
export type MarkdownArgs<K extends MarkdownCommand> = Parameters<MarkdownCommands[K]>[0]
export type MarkdownResult<K extends MarkdownCommand> = Awaited<ReturnType<MarkdownCommands[K]>>

export type MarkdownCall = <K extends MarkdownCommand>(command: K, args: MarkdownArgs<K>) => Promise<MarkdownResult<K>>

export function markdownClient(invoke: (command: string, args: unknown) => Promise<unknown>): MarkdownCall {
  return (command, args) => invoke(command, args) as never
}

export function markdownEmitter(
  emit: (event: string, payload: unknown) => void
): <K extends keyof MarkdownEvents>(event: K, payload: MarkdownEvents[K]) => void {
  return (event, payload) => { emit(event, payload) }
}

export function markdownSubscriber(
  on: (event: string, listener: (payload: never) => void) => void
): <K extends keyof MarkdownEvents>(event: K, listener: (payload: MarkdownEvents[K]) => void) => void {
  return (event, listener) => { on(event, listener as (payload: never) => void) }
}

export type MarkdownHandlers = {
  [K in MarkdownCommand]: (args: MarkdownArgs<K>) => MarkdownResult<K> | Promise<MarkdownResult<K>>
}

export function registerMarkdownCommands(
  register: (name: string, handler: (payload: unknown) => unknown) => void,
  handlers: MarkdownHandlers
): void {
  for (const [name, handler] of Object.entries(handlers)) {
    register(name, handler as (payload: unknown) => unknown)
  }
}
