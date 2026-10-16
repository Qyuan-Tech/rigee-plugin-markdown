# Markdown Preview for Rigee

A [Rigee](https://github.com/Qyuan-Tech/rigee) plugin: a Markdown file read the way it renders —
GitHub-flavoured, with tables, task lists, alerts, footnotes and front matter — and kept current as
the file changes on disk, so a file an agent is writing in the terminal next door redraws as it
grows. Code blocks are coloured by Rigee's own editor tokenizers; links to other Markdown files open
in a preview of their own; pictures on disk are shown, and pictures on the web only when asked for.

## Installing

In Rigee, open the **Plugins** view, search for `markdown` and install
**Qyuan-Tech/rigee-plugin-markdown**. Rigee downloads the latest release, checks it against the
checksum GitHub reports for it, and asks before anything runs. It needs Rigee 1.1.0 or later.

It is offered, never chosen: a Markdown file still opens in the text editor to be written, and the
preview is **Open Preview** in the file's menu.

What it declares: **read files on this computer** — the document, and the pictures it shows — and
**the network**, for exactly one thing: pictures on the web, fetched only when you press the button
that asks for them. Until then a remote picture is a placeholder and nothing leaves the machine. As
with every Rigee plugin, that is a statement of what it is for, not a limit Rigee enforces.

## How it is built

Two halves. The renderer reads the file through Rigee and draws it; the main half watches it — one
watch per folder, so an editor's atomic save does not leave it deaf — and reads the pictures a
document shows, which the window cannot reach.

Parsing runs in a worker, started through Rigee's `workerUrl`, so that a large file never stalls the
window and one written to make the parser loop for ever can be put down. What it renders to is
bounded as well as how long it takes, and raw HTML in the document is sanitised (DOMPurify) before
any of it reaches the page.

```
src/protocol.ts             the commands and event the halves share, typed for both
src/names.ts                the view type and extensions, read from package.json's manifest
src/main/index.ts           main half: watches files, reads and fetches pictures
src/renderer/index.tsx      renderer half: binds the editor
src/renderer/parse.worker.ts  Markdown to HTML, off the window's thread
```

```bash
pnpm install
pnpm run typecheck
pnpm run build          # dist/main.js, dist/renderer.js, dist/parse.worker.js
npm pack                # rigee-plugin-markdown-<version>.tgz, the release asset
```

To try a build in Rigee without publishing it, unpack the tarball's `package/` into
`<userData>/plugins/markdown/` and approve it in the Plugins view.

## Releasing

Set the same version in `version` and `rigee.version`, commit, and push a tag `v<version>`. The
release workflow checks the three agree, builds, packs, and publishes a release carrying
`rigee-plugin-markdown-<version>.tgz` — the one asset Rigee installs from.

## Licence

MIT. Bundled: [marked](https://github.com/markedjs/marked) (MIT) and
[DOMPurify](https://github.com/cure53/DOMPurify) (MPL-2.0 or Apache-2.0).
