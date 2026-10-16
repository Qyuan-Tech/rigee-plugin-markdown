import { subscribeTabs } from '@rigee/plugin-api'
import { MarkdownView } from './MarkdownView'
import { forget } from './memory'
import { setParseWorker, stopParsing } from './parse'
import { connect, fileChanged } from './rpc'
import { PREVIEW_VIEW } from '../names'
import { markdownSubscriber } from '../protocol'
import type { Context, Plugin } from 'cordis'

// This module is dist/renderer.js, so its own URL is the one fixed point in the build's layout:
// the parsing worker is built beside it.
setParseWorker(new URL('./parse.worker.js', import.meta.url))

/**
 * The Markdown preview's renderer half: park the RPC client, hear about files changing, bind the
 * editor — and let go of what outlives a pane, which nothing else would: the parsing worker, with
 * the plugin, and each tab's remembered pictures, with the tab.
 *
 * `inject` is mandatory and `apply` must have a braced body: cordis reads a plugin's RETURN VALUE
 * as an effect, so an arrow body that returns `ctx.contributions.editor(...)` throws.
 */
const plugin: Plugin = {
  name: 'markdown',
  inject: ['contributions', 'rpc'],
  apply(ctx: Context) {
    // Captured once and bound: a detached cordis service method has no `this`.
    const rpc = ctx.rpc
    ctx.effect(() => connect(rpc.invoke.bind(rpc)), 'markdown rpc')
    const on = markdownSubscriber(rpc.on.bind(rpc))
    on('changed', ({ path }) => { fileChanged(path) })
    ctx.effect(() => () => { stopParsing(new Error('The Markdown preview was switched off.')) }, 'markdown worker')
    ctx.effect(() => subscribeTabs((live) => { forget(live) }), 'markdown tab memory')
    ctx.effect(() => () => { forget() }, 'markdown pictures')
    ctx.contributions.editor(PREVIEW_VIEW, MarkdownView)
  }
}

export default plugin
