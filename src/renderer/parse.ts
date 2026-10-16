import { workerUrl } from '@rigee/plugin-api'
import type { ParseJob, ParseReply } from './parse.worker'

/**
 * Markdown to HTML, in the worker — see parse.worker.ts for why there.
 *
 * One worker for every preview, started by the first parse and put down with the plugin, and ONE
 * document in it at a time. The rest wait here, where a newer version of a document can still take
 * the place of an older one that has not started: a file an agent is writing changes faster than a
 * big one parses, and only its latest text is worth the time.
 *
 * A parse that has not answered PARSE_TIMEOUT_MS after it STARTED has hung — time spent waiting
 * behind another does not count — and that is the one thing a worker cannot get out of by itself.
 * It is terminated, that document alone is told why, and the next one starts in a fresh worker.
 * One at a time is also what makes a crash attributable: it was the document being parsed.
 */

const PARSE_TIMEOUT_MS = 10_000

interface Job {
  /** Who asked. A later job from the same caller replaces this one while it waits. */
  owner: string
  text: string
  resolve: (html: string) => void
  reject: (reason: Error) => void
}

let worker: Worker | null = null
/** dist/parse.worker.js, as a URL. Set by the entry module, the one file whose own URL is known. */
let script: URL | null = null

/**
 * Where the worker's script is. Called once by renderer/index.tsx; this module may be bundled into
 * a chunk under dist/chunks/, where its own `import.meta.url` would name the wrong directory.
 */
export function setParseWorker(url: URL): void {
  script = url
}
let lastId = 0
const waiting: Job[] = []
let running: { id: number; job: Job; timer: number } | null = null

export function parseMarkdown(owner: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stale = waiting.findIndex((job) => job.owner === owner)
    if (stale >= 0) waiting.splice(stale, 1)[0]!.reject(new Error('A newer version of this document is being rendered.'))
    waiting.push({ owner, text, resolve, reject })
    next()
  })
}

/** Put the worker down and fail everything it held or was about to. The next parse starts another. */
export function stopParsing(reason: Error): void {
  worker?.terminate()
  worker = null
  if (running) {
    clearTimeout(running.timer)
    running.job.reject(reason)
    running = null
  }
  for (const job of waiting.splice(0)) job.reject(reason)
}

function next(): void {
  if (running || waiting.length === 0) return
  const job = waiting.shift()!
  const id = ++lastId
  running = { id, job, timer: window.setTimeout(() => { if (running?.id === id) fail(new Error('This document took too long to render.')) }, PARSE_TIMEOUT_MS) }
  worker ??= start()
  worker.postMessage({ id, text: job.text } satisfies ParseJob)
}

function start(): Worker {
  if (!script) throw new Error('the Markdown worker was started before the plugin said where it is')
  // Through `workerUrl`: a window may only start a worker from its own origin, and this script is
  // served from the plugin's. Built self-contained — a worker has no import map.
  const w = new Worker(workerUrl(script), { type: 'module', name: 'markdown' })
  w.onmessage = (event: MessageEvent<ParseReply>) => {
    const reply = event.data
    if (!running || running.id !== reply.id) return
    const { job, timer } = running
    clearTimeout(timer)
    running = null
    if ('html' in reply) job.resolve(reply.html)
    else job.reject(new Error(reply.error))
    next()
  }
  // A crash rather than a hang — out of memory, say. Either way the worker is gone.
  w.onerror = (event) => {
    event.preventDefault()
    fail(new Error(event.message || 'The Markdown renderer stopped.'))
  }
  return w
}

/** The running parse is past saving: put the worker down, fail that document, and go on to the next. */
function fail(reason: Error): void {
  worker?.terminate()
  worker = null
  if (running) {
    clearTimeout(running.timer)
    running.job.reject(reason)
    running = null
  }
  next()
}
