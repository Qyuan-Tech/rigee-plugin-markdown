/**
 * Builds the two halves Rigee loads, into dist/:
 *
 *   dist/main.js       the main half. ONE file, for Node, with only `electron` and Node's own
 *                      modules left out. One file because Rigee re-imports it under a new URL after
 *                      an update, and a second file it imported would come back from Node's module
 *                      cache as the old one.
 *   dist/renderer.js   the renderer half, for the window. React and @rigee/plugin-api are left OUT
 *                      and resolved at runtime by Rigee's import map to the shell's own copies: two
 *                      Reacts in one window break hooks, and a second copy of the API package talks
 *                      to a host nobody installed.
 *   dist/parse.worker.js
 *                      the parser, in a worker, started through Rigee's `workerUrl`. Everything it
 *                      needs is bundled into it: a worker has no import map.
 *
 * Not minified, on purpose. A plugin runs with Rigee's access to the user's files, and the release
 * tarball is what they install: it should be code a person can read.
 */

import { build } from 'esbuild'
import { readFile, rm } from 'node:fs/promises'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const id = pkg.rigee.id

await rm('dist', { recursive: true, force: true })

/** The bare names the shell's import map answers. Exactly these: a subpath is not in the map. */
const SHELL_PROVIDED = /^(react|react-dom|react\/jsx-runtime|react\/jsx-dev-runtime|@rigee\/plugin-api)$/

const shellProvided = {
  name: 'shell-provided',
  setup(b) {
    b.onResolve({ filter: SHELL_PROVIDED }, (args) => ({ path: args.path, external: true }))
  }
}

/**
 * A CSS import becomes a <style> element, added when the module first loads. The window's policy
 * does not load stylesheets from a plugin's URL, and an inline style is what it does allow.
 */
const inlineCss = {
  name: 'inline-css',
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, async (args) => {
      const css = await readFile(args.path, 'utf8')
      return {
        loader: 'js',
        contents: [
          `const style = document.createElement('style')`,
          `style.dataset.rigeePlugin = ${JSON.stringify(id)}`,
          `style.textContent = ${JSON.stringify(css)}`,
          `document.head.append(style)`
        ].join('\n')
      }
    })
  }
}

const common = { bundle: true, format: 'esm', logLevel: 'info', legalComments: 'inline', charset: 'utf8' }

await build({
  ...common,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main.js',
  platform: 'node',
  target: 'node24',
  external: ['electron']
})

await build({
  ...common,
  entryPoints: { renderer: 'src/renderer/index.tsx' },
  outdir: 'dist',
  platform: 'browser',
  target: 'chrome152',
  jsx: 'automatic',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  plugins: [shellProvided, inlineCss]
})

await build({
  ...common,
  entryPoints: { 'parse.worker': 'src/renderer/parse.worker.ts' },
  outdir: 'dist',
  platform: 'browser',
  target: 'chrome152'
})
