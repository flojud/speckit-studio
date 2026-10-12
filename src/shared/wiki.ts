export interface WikiPage {
  /** Path relative to docs/wiki, e.g. `auth/decisions.md`. */
  file: string
  title: string
}

const WIKILINK = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g

/** Distinct link targets of `[[Target]]` / `[[Target|label]]`. */
export const wikiLinks = (md: string): string[] => [...new Set([...md.matchAll(WIKILINK)].map((m) => m[1].trim()))]

/** Turns wikilinks into `#wiki/<target>` Markdown links (react-markdown drops custom schemes). */
export const renderWikiLinks = (md: string): string =>
  md.replace(WIKILINK, (_, target: string, label?: string) => `[${(label ?? target).trim()}](#wiki/${encodeURIComponent(target.trim())})`)

export const slugify = (title: string): string =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'page'

/** Finds a page by title or file name (case-insensitive, slug-tolerant). */
export function resolvePage(pages: WikiPage[], name: string): WikiPage | undefined {
  const slug = slugify(name)
  return pages.find((p) => p.title.toLowerCase() === name.toLowerCase().trim() || slugify(p.title) === slug || slugify(p.file.replace(/\.md$/, '')) === slug)
}
