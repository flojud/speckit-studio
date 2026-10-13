import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORK_ITEM_CATEGORIES, WORK_ITEM_STATUSES, type Artifact, type Constitution, type Phase, type ProjectSnapshot, type Spec, type Task, type WorkItem } from '../shared/types.ts'
import { resolvePage, slugify, wikiLinks, type WikiPage } from '../shared/wiki.ts'

// Upstream → downstream chain used for stale detection.
const CHAIN = ['spec.md', 'plan.md', 'tasks.md']
const ORDER = ['spec.md', 'plan.md', 'research.md', 'data-model.md', 'quickstart.md', 'tasks.md']

export const CONSTITUTION = '.specify/memory/constitution.md'
export const WIKI_DIR = 'docs/wiki'
export const WORK_ITEMS_DIR = 'work-items'

const read = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)

export function readProject(path: string): ProjectSnapshot {
  const base = { path, specs: [], workItems: [], wiki: [], commandPrefix: '/speckit.' }
  if (!existsSync(path)) return { ...base, initialized: false, missing: true }
  if (!existsSync(join(path, '.specify'))) return { ...base, initialized: false, missing: false }

  const specsDir = join(path, 'specs')
  const keys = existsSync(specsDir)
    ? readdirSync(specsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : []
  const constitutionFile = join(path, CONSTITUTION)
  const constitution = parseConstitution(read(constitutionFile))
  if (constitution) constitution.mtime = statSync(constitutionFile).mtimeMs
  return {
    path,
    initialized: true,
    missing: false,
    ...readIntegration(path),
    constitution,
    specs: keys.map((k) => readSpec(path, `specs/${k}`, k, constitution?.mtime)),
    workItems: listWorkItems(path),
    wiki: listWiki(path)
  }
}

const INTEGRATION = '.specify/integration.json'

export function readIntegration(path: string): { integration?: string; studioAgent?: string; commandPrefix: string } {
  try {
    const cfg = JSON.parse(readFileSync(join(path, INTEGRATION), 'utf8'))
    const sep = cfg.integration_settings?.[cfg.integration]?.invoke_separator ?? '.'
    return { integration: cfg.integration, ...(cfg.studio_agent ? { studioAgent: cfg.studio_agent } : {}), commandPrefix: `/speckit${sep}` }
  } catch {
    return { commandPrefix: '/speckit.' }
  }
}

/**
 * Assigns a studio agent to the project (`null` = inherit), keeping every Spec Kit key.
 * Its own key, not `integration`: that one is Spec Kit's and drives the command names.
 */
export function writeStudioAgent(path: string, agentId: string | null): void {
  const file = join(path, INTEGRATION)
  if (!existsSync(join(path, '.specify'))) throw new Error('Not a Spec Kit project (no .specify folder)')
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  if (agentId) cfg.studio_agent = agentId
  else delete cfg.studio_agent
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`)
}

export function parseConstitution(md: string | undefined): Constitution | undefined {
  if (!md) return undefined
  const field = (name: string): string | undefined =>
    md.match(new RegExp(`\\*\\*${name}\\*\\*:\\s*([^|\\n]+)`))?.[1].trim()
  return { version: field('Version'), ratified: field('Ratified'), amended: field('Last Amended') }
}

/** Reads one spec folder (`rel` relative to `root`; a worktree copy while one exists). */
export function readSpec(root: string, rel: string, key: string, constitutionMtime?: number): Spec {
  const dir = join(root, rel)
  const artifacts = listArtifacts(dir, constitutionMtime)
  const spec = read(join(dir, 'spec.md'))
  const draft = read(join(dir, 'draft.md'))
  const draftHeading = draft?.match(/^#\s+(.+)$/m)
  const tasks = parseTasks(read(join(dir, 'tasks.md')) ?? '')
  // Markers quoted in code (`[NEEDS CLARIFICATION`) are documentation, not open questions.
  const openClarifications = spec?.replace(/`[^`\n]*`/g, '').match(/\[NEEDS CLARIFICATION/g)?.length ?? 0
  const has = (f: string): boolean => artifacts.some((a) => a.file === f)

  let phase: Phase = 'draft'
  if (spec !== undefined) phase = 'specified'
  if (spec && /^## Clarifications\s*$/m.test(spec) && openClarifications === 0) phase = 'clarified'
  if (has('plan.md')) phase = 'planned'
  if (has('tasks.md')) phase = 'tasked'
  const done = tasks.filter((t) => t.done).length
  if (done > 0) phase = done === tasks.length ? 'done' : 'implementing'

  return {
    key,
    dir: rel,
    number: key.match(/^(\d+)/)?.[1] ?? '',
    title: spec?.match(/^#\s+(?:Feature Specification:\s*)?(.+)$/m)?.[1].trim() ?? draftHeading?.[1].trim() ?? key.replace(/^\d+-/, ''),
    phase,
    artifacts,
    tasks,
    openClarifications,
    ...(spec === undefined && draft !== undefined
      ? { description: (draftHeading ? draft.slice(draftHeading.index! + draftHeading[0].length) : draft).trim() }
      : {})
  }
}

/** Content of `draft.md`: a `# Title` heading and the description. */
export const draftMarkdown = (title: string, description: string): string =>
  description.trim() ? `# ${title.trim()}\n\n${description.trim()}\n` : `# ${title.trim()}\n`

/**
 * Next spec number prefix, the same rule as Spec Kit's git extension: sequential = highest `NNN-` + 1
 * (timestamp names `YYYYMMDD-HHMMSS-` don't count), timestamp = local `YYYYMMDD-HHMMSS`.
 */
export function nextSpecPrefix(names: string[], scheme: 'sequential' | 'timestamp', now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  if (scheme === 'timestamp')
    return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  const max = Math.max(0, ...names.filter((n) => !/^\d{8}-\d{6}-/.test(n)).map((n) => Number(n.match(/^(\d{3,})-/)?.[1] ?? 0)))
  return p(max + 1, 3)
}

/** `branch_numbering` from the git extension config, then init options; default sequential. */
export function numberingScheme(root: string): 'sequential' | 'timestamp' {
  const yml = read(join(root, '.specify/extensions/git/git-config.yml'))?.match(/^branch_numbering:\s*["']?(\w+)/m)?.[1]
  let opts: string | undefined
  try {
    opts = JSON.parse(read(join(root, '.specify/init-options.json')) ?? '{}').branch_numbering
  } catch {
    // ignore a broken init-options.json
  }
  return (yml ?? opts) === 'timestamp' ? 'timestamp' : 'sequential'
}

/** A plan is also stale when the constitution changed after it was written. */
function listArtifacts(dir: string, constitutionMtime = 0): Artifact[] {
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const mtimes = Object.fromEntries(files.map((f) => [f, statSync(join(dir, f)).mtimeMs]))
  // ponytail: mtime-based; a fresh clone/checkout can produce false positives. Use git log times if that bites.
  return files.map((file) => {
    const i = CHAIN.indexOf(file)
    let upstream = i > 0 ? mtimes[CHAIN[i - 1]] : undefined
    if (file === 'plan.md') upstream = Math.max(upstream ?? 0, constitutionMtime)
    return { file, mtime: mtimes[file], stale: upstream !== undefined && upstream > mtimes[file] }
  })
}

const rank = (f: string): number => {
  const i = ORDER.indexOf(f)
  return i === -1 ? ORDER.length : i
}

const TASK = /^\s*[-*]\s+\[([ xX])\]\s+(T\d+)\s+((?:\[[^\]]+\]\s*)*)(.*)$/

export function parseTasks(md: string): Task[] {
  const tasks: Task[] = []
  let section = ''
  for (const line of md.split('\n')) {
    const h = line.match(/^##\s+(.+)$/)
    if (h) section = h[1].trim()
    const m = line.match(TASK)
    if (!m) continue
    const tags = [...m[3].matchAll(/\[([^\]]+)\]/g)].map((t) => t[1])
    tasks.push({
      id: m[2],
      done: m[1] !== ' ',
      parallel: tags.includes('P'),
      story: tags.find((t) => /^US\d+$/.test(t)),
      text: m[4].trim(),
      section
    })
  }
  return tasks
}

/** Sets the checkbox of task `id`; returns the new Markdown, or undefined if the task is not found. */
export function setTaskDone(md: string, id: string, done: boolean): string | undefined {
  const line = new RegExp(`^(\\s*[-*]\\s+\\[)[ xX](\\]\\s+${id}\\b)`, 'm')
  return line.test(md) ? md.replace(line, `$1${done ? 'X' : ' '}$2`) : undefined
}

// --- non-code work items: work-items/WI-###-<slug>.md with title/category/status frontmatter

const has = <T extends string>(list: readonly T[], v: string | undefined): v is T => list.includes(v as T)

function unquote(v: string): string {
  if (/^".*"$/.test(v))
    try {
      return JSON.parse(v)
    } catch {
      // not JSON-escaped: strip the quotes below
    }
  return v.replace(/^(["'])(.*)\1$/, '$2')
}

/** Never throws: missing or broken frontmatter falls back to heading/key, `general` and `draft`. */
export function parseWorkItem(key: string, md: string, mtime = 0): WorkItem {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  const fields: Record<string, string> = {}
  for (const line of fm?.[1].split(/\r?\n/) ?? []) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (m) fields[m[1]] = unquote(m[2].trim())
  }
  const body = (fm ? md.slice(fm[0].length) : md).replace(/^\r?\n/, '')
  return {
    key,
    file: `${WORK_ITEMS_DIR}/${key}.md`,
    title: fields.title || body.match(/^#\s+(.+)$/m)?.[1].trim() || key,
    category: has(WORK_ITEM_CATEGORIES, fields.category) ? fields.category : 'general',
    status: has(WORK_ITEM_STATUSES, fields.status) ? fields.status : 'draft',
    body,
    mtime
  }
}

/** Title is JSON-quoted (a valid YAML double-quoted string), so colons and quotes survive. */
export const workItemMarkdown = (w: Pick<WorkItem, 'title' | 'category' | 'status' | 'body'>): string =>
  `---\ntitle: ${JSON.stringify(w.title.trim())}\ncategory: ${w.category}\nstatus: ${w.status}\n---\n\n${w.body.trim() ? `${w.body.trim()}\n` : ''}`

/** `WI-<highest existing + 1, 3 digits>-<first 4 slug words>`. */
export function nextWorkItemKey(names: string[], title: string): string {
  const max = Math.max(0, ...names.map((n) => Number(n.match(/^WI-(\d+)/i)?.[1] ?? 0)))
  return `WI-${String(max + 1).padStart(3, '0')}-${slugify(title).split('-').slice(0, 4).join('-')}`
}

export function listWorkItems(root: string): WorkItem[] {
  const dir = join(root, WORK_ITEMS_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parseWorkItem(f.slice(0, -3), readFileSync(join(dir, f), 'utf8'), statSync(join(dir, f)).mtimeMs))
}

const mdFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.md')).sort() : []

export function listWiki(root: string): WikiPage[] {
  const dir = join(root, WIKI_DIR)
  return mdFiles(dir).map((file) => ({
    file,
    title: readFileSync(join(dir, file), 'utf8').match(/^#\s+(.+)$/m)?.[1].trim() ?? file.replace(/\.md$/, '').split('/').pop()!
  }))
}

/** Files (relative to root) in the wiki and in specs that link to `page`. */
export function backlinks(root: string, page: WikiPage): string[] {
  const pages = listWiki(root)
  const files = [...mdFiles(join(root, WIKI_DIR)).map((f) => `${WIKI_DIR}/${f}`), ...mdFiles(join(root, 'specs')).map((f) => `specs/${f}`)]
  return files.filter(
    (f) => f !== `${WIKI_DIR}/${page.file}` && wikiLinks(readFileSync(join(root, f), 'utf8')).some((name) => resolvePage(pages, name)?.file === page.file)
  )
}
