import pkg from '../package.json' with { type: 'json' }

/**
 * The names this plugin's code needs from its manifest, read FROM the manifest — package.json's
 * `rigee` section — rather than written out a second time to drift from it.
 */

const editor = pkg.rigee.contributes.editors[0]!

/** The preview's view type, which the renderer half also opens linked Markdown files in. */
export const PREVIEW_VIEW: string = editor.viewType

/** What counts as Markdown: the extensions VS Code gives the language, lower-case, no dot. */
export const MARKDOWN_EXTENSIONS: readonly string[] = editor.selector.extensions
