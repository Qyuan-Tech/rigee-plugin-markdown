import { MARKDOWN_EXTENSIONS } from '../names'
import type { Workspace } from '@rigee/plugin-api'

/**
 * Where the links and pictures in a Markdown file point, worked out in the renderer, which has no
 * node:path. Both separators throughout: a workspace opened on Windows carries backslashes through.
 */

/** Both separators, and the root folder named by itself rather than by nothing. */
export const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

export function dirname(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut < 0) return path
  // A root keeps its separator: `/`, `C:\`.
  const root = cut === 0 || (cut === 2 && /^[a-zA-Z]:/.test(path))
  return path.slice(0, root ? cut + 1 : cut)
}

/** `C:\x` or `C:/x`. Checked before anything else, because `C:` also looks like a URL's scheme. */
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/
const SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/

export const isMarkdownPath = (path: string): boolean =>
  MARKDOWN_EXTENSIONS.includes(path.slice(path.lastIndexOf('.') + 1).toLowerCase())

/** `rel` from the folder `dir`, with `.` and `..` worked out, written with `dir`'s own separator. */
export function joinPath(dir: string, rel: string): string {
  const sep = WINDOWS_ABSOLUTE.test(dir) || (dir.includes('\\') && !dir.includes('/')) ? '\\' : '/'
  const parts = dir.split(/[\\/]/)
  // `/` splits into two empty strings and `C:\` ends in one: keep the root, drop the rest.
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  for (const part of rel.split(/[\\/]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 1) parts.pop()
    } else parts.push(part)
  }
  // Only the root is left — `''` for `/`, `C:` for `C:\` — and it needs its separator back.
  return parts.length === 1 ? parts[0] + sep : parts.join(sep)
}

/**
 * The folder a leading slash means in this file's links: the root of the repository it is in, as
 * GitHub reads one, or of the workspace folder holding it when that is not a repository. Null for a
 * file outside every folder, whose leading slash is then the disk's own root.
 */
export function rootFor(file: string, workspace: Workspace | null): string | null {
  let best: { path: string; root: string } | null = null
  for (const folder of workspace?.folders ?? []) {
    if (!inside(file, folder.path)) continue
    if (!best || folder.path.length > best.path.length) best = { path: folder.path, root: folder.repoRoot ?? folder.path }
  }
  return best?.root ?? null
}

function inside(file: string, dir: string): boolean {
  const folder = dir.replace(/[\\/]+$/, '')
  return file.startsWith(folder + '/') || file.startsWith(folder + '\\')
}

/** Two spellings of one file — the separators are the only difference worth forgiving. */
export const samePath = (a: string, b: string): boolean => a.replace(/\\/g, '/') === b.replace(/\\/g, '/')

/**
 * Where a link or a picture in `file` points on disk, and the part after `#`; or null when it is
 * not a file at all — an address on the web, `mailto:`, any other scheme. An empty path, a bare
 * `#anchor`, is the file itself.
 */
export function localTarget(href: string, file: string, root: string | null): { path: string; fragment: string } | null {
  const hash = href.indexOf('#')
  const fragment = hash < 0 ? '' : decode(href.slice(hash + 1))
  let target = hash < 0 ? href : href.slice(0, hash)
  const query = target.indexOf('?')
  if (query >= 0) target = target.slice(0, query)
  target = decode(target)

  if (WINDOWS_ABSOLUTE.test(target)) return { path: target, fragment }
  // Two separators first names another machine: `//host/x` on the web, `\\host\share\x` or `/\host`
  // on Windows — where merely asking for the file connects to that host and hands it who you are.
  // Never on a document's say-so. A relative path in a document that is itself on a share still
  // resolves onto that share, the one the user already opened it from.
  if (SCHEME.test(target) || /^[\\/]{2}/.test(target)) return null
  if (target === '') return { path: file, fragment }
  if (target.startsWith('/') || target.startsWith('\\')) return { path: root ? joinPath(root, target) : target, fragment }
  return { path: joinPath(dirname(file), target), fragment }
}

/** Percent-escapes undone, as a browser would before asking the disk; a malformed one left as written. */
function decode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
