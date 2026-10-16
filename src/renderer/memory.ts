/**
 * What a preview remembers about its tab from one mount to the next.
 *
 * Switching tabs unmounts the pane, and coming back has to find it as it was: scrolled to the same
 * place, with the same answer about pictures on the web — and with those pictures already here, so
 * that the page is laid out at its full height the moment it is drawn and the place can actually be
 * gone back to. Pictures read again on every visit would arrive after the page had been laid out
 * without them, shorter, and the place would be lost to the scroll clamping to it.
 *
 * Module state rather than the tab's own: none of it is worth a write to workspaces.json, and a
 * blob: URL does not outlive the page anyway. Kept until the tab closes — the renderer entry
 * watches the shell's tabs and forgets the ones that went — or the plugin is switched off.
 */

/**
 * A picture's blob: URL, on its way — and once it has arrived, the URL itself, for using at once;
 * or why it could not be had, for standing in for it at once. An attempt made again after a failure
 * carries that failure until it has an answer of its own.
 */
export interface Picture {
  url: Promise<string>
  ready?: string
  failed?: string
  settled: boolean
}

export interface TabMemory {
  /** How far down the reader had scrolled. */
  position: number
  /** Whether the reader asked for the pictures on the web. Asked per document read, not a setting. */
  remote: boolean
  /** The pictures, by where each came from: a path on disk, or an address. */
  pictures: Map<string, Picture>
}

const memories = new Map<string, TabMemory>()

/**
 * A tab's memory, made on first sight. A split copy starts from what the tab it was split from
 * remembers — where it had got to, and what its reader said — but not with its pictures, which
 * belong to that tab and go when it does.
 */
export function remember(tabId: string, from: string | null = null): TabMemory {
  let memory = memories.get(tabId)
  if (!memory) {
    const origin = from === null ? undefined : memories.get(from)
    memory = { position: origin?.position ?? 0, remote: origin?.remote ?? false, pictures: new Map() }
    memories.set(tabId, memory)
  }
  return memory
}

export function release(picture: Picture): void {
  void picture.url.then(URL.revokeObjectURL, () => {})
}

/** Forget every tab not in `live` — or, given nothing, every tab — letting its pictures go. */
export function forget(live?: ReadonlySet<string>): void {
  for (const [tabId, memory] of memories) {
    if (live?.has(tabId)) continue
    for (const picture of memory.pictures.values()) release(picture)
    memories.delete(tabId)
  }
}
