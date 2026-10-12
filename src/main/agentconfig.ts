import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import type { AgentConfigState, ConfigAgent, ConfigItem, ConfigKind, FileChange, Finding, FindingRule, SectionDiff } from '../shared/types.ts'
import { slugify } from '../shared/wiki.ts'
import { git, tryGit } from './git.ts'

/** Where each agent reads its instructions. Context files are found in any folder, skills and subagents at the root only. */
export const LOCATIONS: Record<ConfigAgent, Partial<Record<ConfigKind, string>>> = {
  claude: { context: 'CLAUDE.md', skill: '.claude/skills', subagent: '.claude/agents' },
  gemini: { context: 'GEMINI.md', skill: '.gemini/skills' },
  shared: { context: 'AGENTS.md' }
}
const AGENTS = Object.keys(LOCATIONS) as ConfigAgent[]

export const MAX_LINES = 300
export const MAX_BYTES = 40_000
export const MAX_DESC = 1024
export const MIN_WORDS = 4
/** Larger files are listed and flagged, but not parsed, diffed or previewed. */
export const LARGE = 1_000_000

const SKIP = /(^|\/)(\.git|node_modules)(\/|$)|^\.studio\/worktrees(\/|$)/
const IMPORT = /^\s*@AGENTS\.md\s*$/
const FENCE = /^\s*(```|~~~)/
const lines = (md: string): string[] => md.split(/\r?\n/)
const unquote = (v: string): string => v.replace(/^(["'])(.*)\1$/, '$2')
const relIn = (dir: string, f: string): string => (dir ? `${dir}/${f}` : f)

// --- frontmatter and Spec Kit markers

/** Top-level `key: value` and `key: >`/`|` block scalars of a leading `---` block. Nested maps are skipped (no YAML dependency). */
export function frontmatter(md: string): { ok: boolean; data: Record<string, string>; bodyStart: number } {
  const ls = lines(md)
  const end = ls[0]?.trim() === '---' ? ls.findIndex((l, i) => i > 0 && l.trim() === '---') : -1
  if (end < 0) return { ok: false, data: {}, bodyStart: 0 }
  const data: Record<string, string> = {}
  let block: string | undefined
  for (const l of ls.slice(1, end)) {
    const m = l.match(/^([\w-]+):\s*(.*)$/)
    if (m) {
      const v = m[2].trim()
      block = /^[|>][+-]?$/.test(v) ? m[1] : undefined
      if (block) data[m[1]] = ''
      else if (v) data[m[1]] = unquote(v)
    } else if (block && l.trim()) data[block] = `${data[block]} ${l.trim()}`.trim()
  }
  return { ok: true, data, bodyStart: end + 1 }
}

export interface Markers {
  start: string
  end: string
}
export const DEFAULT_MARKERS: Markers = { start: '<!-- SPECKIT START -->', end: '<!-- SPECKIT END -->' }

/** The markers Spec Kit's agent-context extension writes, from its config. */
export function readMarkers(root: string): Markers {
  const file = join(root, '.specify/extensions/agent-context/agent-context-config.yml')
  const yml = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const get = (k: keyof Markers): string => unquote(yml.match(new RegExp(`^\\s+${k}:\\s*(.+?)\\s*$`, 'm'))?.[1] ?? DEFAULT_MARKERS[k])
  return { start: get('start'), end: get('end') }
}

function scanMarkers(md: string, m: Markers): { blocks: { start: number; end: number }[]; problem?: { line: number; text: string } } {
  const blocks: { start: number; end: number }[] = []
  let open = 0
  for (const [i, l] of lines(md).entries()) {
    const n = i + 1
    if (l.trim() === m.start) {
      if (open) return { blocks, problem: { line: n, text: `Nested ${m.start} on line ${n}` } }
      open = n
    } else if (l.trim() === m.end) {
      if (!open) return { blocks, problem: { line: n, text: `${m.end} on line ${n} has no matching start` } }
      blocks.push({ start: open, end: n })
      open = 0
    }
  }
  return open ? { blocks, problem: { line: open, text: `${m.start} on line ${open} has no matching end` } } : { blocks }
}

/** 1-based line ranges managed by Spec Kit. */
export const managedBlocks = (md: string, m: Markers): { start: number; end: number }[] => scanMarkers(md, m).blocks
/** What is wrong with the markers, or undefined when every start has its end. */
export const markerProblem = (md: string, m: Markers): string | undefined => scanMarkers(md, m).problem?.text

// --- discovery

/** Files below `dir` (relative, `/`-separated) without .git, node_modules and studio worktrees. Symlinked folders aren't entered. */
function walk(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((d) => {
    const p = rel ? `${rel}/${d.name}` : d.name
    return SKIP.test(p) ? [] : d.isDirectory() ? walk(dir, p) : [p]
  })
}

/** Project files git doesn't ignore (git applies every ignore source itself); a plain walk outside git. */
export async function projectFiles(root: string): Promise<{ files: string[]; isRepo: boolean }> {
  if ((await tryGit(root, 'rev-parse', '--is-inside-work-tree')) !== 'true') return { files: walk(root), isRepo: false }
  const ls = async (flags: string): Promise<string[]> => (await git(root, 'ls-files', '-z', flags, '--exclude-standard')).split('\0').filter(Boolean)
  const [all, ignored] = await Promise.all([ls('-co'), ls('-ci')]) // -ci: tracked but ignored, e.g. a committed dist/CLAUDE.md
  const drop = new Set(ignored)
  return { files: [...new Set(all)].filter((f) => !drop.has(f) && !SKIP.test(f)), isRepo: true }
}

const owner = (file: string): ConfigAgent | undefined => AGENTS.find((a) => LOCATIONS[a].context === basename(file))
const entries = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])

/** Context files from `files`, skills and subagents from their root folders. Reads everything fresh; stores nothing. */
export function listConfig(root: string, files: string[], markers = readMarkers(root)): ConfigItem[] {
  const real = realpathSync(root)
  const item = (path: string, kind: ConfigKind, agent: ConfigAgent, name: string): ConfigItem => {
    const file = join(root, path)
    const { size, mtimeMs } = statSync(file)
    const md = size > LARGE ? '' : readFileSync(file, 'utf8')
    // Any symlink on the way, or a target outside the project, makes realpath differ.
    const base = { path, kind, agent, name, size, mtime: mtimeMs, readOnly: realpathSync(file) !== join(real, path) }
    if (kind === 'context') return { ...base, managed: managedBlocks(md, markers) }
    const { data } = frontmatter(md)
    return { ...base, name: data.name || name, ...(data.description ? { description: data.description } : {}) }
  }
  const items = files
    .filter((f) => owner(f) && existsSync(join(root, f)))
    .sort()
    .map((f) => item(f, 'context', owner(f)!, f))
  for (const agent of AGENTS) {
    const { skill, subagent } = LOCATIONS[agent]
    if (skill)
      for (const d of entries(join(root, skill)))
        if (existsSync(join(root, skill, d, 'SKILL.md')))
          items.push({ ...item(`${skill}/${d}/SKILL.md`, 'skill', agent, d), extraFiles: walk(join(root, skill, d)).filter((f) => f !== 'SKILL.md') })
    if (subagent)
      for (const f of entries(join(root, subagent)))
        if (f.endsWith('.md') && existsSync(join(root, subagent, f))) items.push(item(`${subagent}/${f}`, 'subagent', agent, f.slice(0, -3)))
  }
  return items
}

// --- health check

function npmScripts(root: string, dir: string): Set<string> {
  for (let d = dir; ; d = dirname(d)) {
    const pkg = join(d, 'package.json')
    if (existsSync(pkg))
      try {
        return new Set(Object.keys(JSON.parse(readFileSync(pkg, 'utf8')).scripts ?? {}))
      } catch {
        return new Set()
      }
    if (d === root || d === dirname(d)) return new Set()
  }
}

const looksLikePath = (t: string): boolean =>
  !/[<>{}*$[\]]|^[/~@-]|^[a-z][\w+.-]*:/i.test(t) && (t.includes('/') || /[^.]\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(t))

/** References in a context file that don't resolve: links, `@path` lines, backticked paths, `npm run <script>`. */
export function references(md: string, file: string, ctx: { root: string; basenames: Set<string> }): { line: number; target: string; kind: 'link' | 'import' | 'path' | 'script' }[] {
  const dir = dirname(join(ctx.root, file))
  const scripts = npmScripts(ctx.root, dir)
  const at = (t: string, base = dir): boolean => existsSync(resolve(base, t))
  const out: ReturnType<typeof references> = []
  let fence = false
  lines(md).forEach((l, i) => {
    const add = (target: string, kind: (typeof out)[number]['kind']): number => out.push({ line: i + 1, target, kind })
    for (const m of l.matchAll(/\bnpm run ([\w:.-]+)/g)) if (!scripts.has(m[1])) add(m[0], 'script') // fenced blocks too
    if (FENCE.test(l)) fence = !fence
    if (fence || FENCE.test(l)) return
    const imp = l.match(/^\s*@(\S+)\s*$/)?.[1]
    if (imp && !/^[~/]/.test(imp) && !at(imp)) add(`@${imp}`, 'import')
    for (const [, t] of l.matchAll(/\]\(([^)\s]+)/g)) {
      const target = t.split('#')[0]
      if (target && !/^([a-z][\w+.-]*:|[#/~])/i.test(t) && !at(target)) add(target, 'link')
    }
    for (const [, t] of l.matchAll(/`([^`\s]+)`/g))
      if (looksLikePath(t) && !at(t, ctx.root) && !at(t) && (t.includes('/') || !ctx.basenames.has(t))) add(t, 'path')
  })
  return out
}

const WARNINGS: FindingRule[] = ['too-long', 'long-description', 'vague-description', 'section-conflict']

/** Local, AI-free checks for every listed file (FR-007). */
export function healthCheck(items: ConfigItem[], ctx: { root: string; basenames: Set<string>; markers: Markers; sync: SectionDiff[] }): Finding[] {
  const out: Finding[] = []
  const add = (file: string, rule: FindingRule, reason: string, fix: string, line?: number): number =>
    out.push({ file, ...(line ? { line } : {}), rule, severity: WARNINGS.includes(rule) ? 'warning' : 'error', reason, fix })
  for (const it of items) {
    const md = it.size > LARGE ? '' : readFileSync(join(ctx.root, it.path), 'utf8')
    if (it.kind === 'context') {
      const n = lines(md.replace(/\r?\n$/, '')).length
      if (it.size > LARGE || n > MAX_LINES || it.size > MAX_BYTES)
        add(it.path, 'too-long', `${it.size > LARGE ? 'Over 1 MB' : `${n} lines, ${Math.round(it.size / 1000)} KB`} – agents follow long context files less reliably.`, `Keep it under ${MAX_LINES} lines and ${MAX_BYTES / 1000} KB: cut what the agent can find out itself, move details into skills or linked docs.`)
      if (it.size > LARGE) continue
      for (const r of references(md, it.path, ctx))
        r.kind === 'script'
          ? add(it.path, 'missing-reference', `\`${r.target}\`: package.json has no "${r.target.slice(8)}" script.`, 'Use an existing script or remove the line.', r.line)
          : add(it.path, 'missing-reference', `\`${r.target}\` does not exist.`, 'Update or remove the reference.', r.line)
      const p = scanMarkers(md, ctx.markers).problem
      if (p) add(it.path, 'broken-markers', `${p.text} – Spec Kit can't update its managed section.`, 'Restore the matching start and end marker lines.', p.line)
      continue
    }
    const fm = frontmatter(md)
    if (!fm.ok) {
      add(it.path, 'bad-frontmatter', 'No frontmatter block (--- … ---), so the agent gets no name or description.', 'Start the file with a --- block that has name: and description:.')
      continue
    }
    if (!fm.data.name) add(it.path, 'missing-name', 'The frontmatter has no name.', 'Add a name: field.')
    const d = fm.data.description
    if (!d) add(it.path, 'missing-description', 'Without a description the agent can’t tell when to use it.', 'Add a description: that says what it does and when to use it.')
    else if (it.kind === 'skill' && d.length > MAX_DESC) add(it.path, 'long-description', `The description has ${d.length} characters (max ${MAX_DESC}).`, 'Shorten it to one or two sentences.')
    else if (it.kind === 'skill' && d.split(/\s+/).length < MIN_WORDS) add(it.path, 'vague-description', `"${d}" is too vague to tell the agent when to use it.`, 'Say what it does and when to use it.')
  }
  // ponytail: O(n²) over ≤ ~50 items
  for (const it of items) {
    const twins = items.filter((o) => o !== it && it.kind !== 'context' && o.kind === it.kind && o.agent === it.agent && o.name === it.name)
    if (twins.length) add(it.path, 'duplicate-name', `"${it.name}" is also the name of ${twins.map((t) => t.path).join(', ')} – the agent can’t tell them apart.`, 'Rename one of them.')
  }
  for (const s of ctx.sync)
    for (const c of s.conflicts)
      for (const [f, line] of [['CLAUDE.md', c.claudeLine], ['GEMINI.md', c.geminiLine]] as const)
        add(relIn(s.dir, f), 'section-conflict', `"${c.heading}" differs between CLAUDE.md and GEMINI.md – the two agents get different instructions.`, 'Make the section the same in both files, or use one shared file.', line)
  return out
}

// --- sections, drift and "Use one shared file"

export interface Section {
  /** '' = text before the first heading; repeated headings get ` (2)`, ` (3)` … */
  heading: string
  line: number
  /** The section's raw lines, heading included */
  text: string
}

/** Flat split at ATX headings outside code fences; joining every `text` with '\n' gives the file back. */
export function sections(md: string): Section[] {
  const out: { heading: string; line: number; rows: string[] }[] = []
  const seen = new Map<string, number>()
  let fence = false
  lines(md).forEach((l, i) => {
    if (FENCE.test(l)) fence = !fence
    const h = !fence && l.match(/^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/)
    if (h) {
      const n = (seen.get(h[1].toLowerCase()) ?? 0) + 1
      seen.set(h[1].toLowerCase(), n)
      out.push({ heading: n > 1 ? `${h[1]} (${n})` : h[1], line: i + 1, rows: [l] })
    } else if (out.length) out.at(-1)!.rows.push(l)
    else out.push({ heading: '', line: 1, rows: [l] })
  })
  return out.map(({ rows, ...s }) => ({ ...s, text: rows.join('\n') }))
}

const sectionKey = (heading: string): string => heading.trim().toLowerCase()

/** Sections keyed by heading, with the body compared for drift: whitespace collapsed, `@AGENTS.md` and managed lines dropped. */
function compared(md: string, m: Markers): Map<string, Section & { body: string; managed: boolean }> {
  const blocks = managedBlocks(md, m)
  const inBlock = (n: number): boolean => blocks.some((b) => n >= b.start && n <= b.end)
  const out = new Map<string, Section & { body: string; managed: boolean }>()
  for (const s of sections(md)) {
    if (s.heading && inBlock(s.line)) continue // Spec Kit's own heading
    const rows = s.text.split('\n').map((r, i) => ({ r, n: s.line + i }))
    const body = rows
      .filter(({ r, n }, i) => !(s.heading && i === 0) && !inBlock(n) && !IMPORT.test(r))
      .map(({ r }) => r)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (s.heading || body) out.set(sectionKey(s.heading), { ...s, body, managed: rows.some(({ n }) => inBlock(n)) })
  }
  return out
}

const label = (heading: string): string => heading || '(preamble)'

export function sectionDiff(claudeMd: string, geminiMd: string, dir: string, m: Markers): SectionDiff {
  const c = compared(claudeMd, m)
  const g = compared(geminiMd, m)
  const only = (a: typeof c, b: typeof c, who: 'claude' | 'gemini'): SectionDiff['drift'] =>
    [...a.entries()].filter(([k]) => !b.has(k)).map(([, s]) => ({ heading: label(s.heading), only: who }))
  return {
    dir,
    drift: [...only(c, g, 'claude'), ...only(g, c, 'gemini')],
    conflicts: [...c.entries()].filter(([k, s]) => g.has(k) && g.get(k)!.body !== s.body).map(([k, s]) => ({ heading: label(s.heading), claudeLine: s.line, geminiLine: g.get(k)!.line })),
    shared: shareable(c, g).map(([, s]) => label(s.heading))
  }
}

const shareable = (c: ReturnType<typeof compared>, g: ReturnType<typeof compared>): [string, Section][] =>
  [...c.entries()].filter(([k, s]) => g.get(k)?.body === s.body && !s.managed && !g.get(k)!.managed)

/**
 * Moves sections that are identical in CLAUDE.md and GEMINI.md to AGENTS.md (appended, unless it already holds them).
 * Everything else stays where it was; each agent file starts with exactly one `@AGENTS.md` line.
 */
export function shareSections(files: { claude: string; gemini: string; agents: string }, m: Markers): { claude: string; gemini: string; agents: string; moved: string[] } {
  const strip = (md: string): string => lines(md).filter((l) => !IMPORT.test(l)).join('\n')
  const claude = strip(files.claude)
  const gemini = strip(files.gemini)
  const move = shareable(compared(claude, m), compared(gemini, m))
  if (!move.length) throw new Error('No identical sections to share')
  const keys = new Set(move.map(([k]) => k))
  const existing = compared(files.agents, m)
  const added = move.filter(([k]) => existing.get(k)?.body !== compared(claude, m).get(k)!.body).map(([, s]) => s.text.trim())
  const rest = (md: string): string => {
    const kept = sections(md).filter((s) => !keys.has(sectionKey(s.heading))).map((s) => s.text).join('\n').trim()
    return `@AGENTS.md\n${kept ? `\n${kept}\n` : ''}`
  }
  return { claude: rest(claude), gemini: rest(gemini), agents: `${[files.agents.trim(), ...added].filter(Boolean).join('\n\n')}\n`, moved: move.map(([, s]) => label(s.heading)) }
}

function syncDiffs(root: string, items: ConfigItem[], m: Markers): SectionDiff[] {
  return items.flatMap((c) => {
    if (c.kind !== 'context' || c.agent !== 'claude' || c.size > LARGE) return []
    const dir = dirname(c.path) === '.' ? '' : dirname(c.path)
    const g = items.find((i) => i.path === relIn(dir, 'GEMINI.md') && i.size <= LARGE)
    return g ? [sectionDiff(readFileSync(join(root, c.path), 'utf8'), readFileSync(join(root, g.path), 'utf8'), dir, m)] : []
  })
}

/** Inventory, findings and drift, computed fresh on every call. Writes nothing. */
export async function configState(root: string): Promise<AgentConfigState> {
  const { files, isRepo } = await projectFiles(root)
  const markers = readMarkers(root)
  const items = listConfig(root, files, markers)
  const sync = syncDiffs(root, items, markers)
  const findings = healthCheck(items, { root: resolve(root), basenames: new Set(files.map((f) => basename(f))), markers, sync })
  return { items, findings, sync, isRepo }
}

// --- writes (explicit user actions only)

/** Returns the absolute path, or throws unless `rel` stays in the project and its nearest existing part is no symlink. */
function assertWritable(root: string, rel: string): string {
  if (isAbsolute(rel) || normalize(rel).startsWith('..')) throw new Error(`Not writable: ${rel}`)
  const real = realpathSync(root)
  for (let p = normalize(rel); p !== '.'; p = dirname(p)) {
    try {
      lstatSync(join(root, p))
    } catch {
      continue // doesn't exist yet: check its parent
    }
    let target: string | undefined
    try {
      target = realpathSync(join(root, p))
    } catch {
      // dangling symlink
    }
    if (target !== join(real, p)) throw new Error(`Not writable: ${rel}`)
    break
  }
  return join(root, rel)
}

const writableItem = async (root: string, path: string): Promise<ConfigItem | undefined> =>
  listConfig(root, (await projectFiles(root)).files).find((i) => i.path === path && !i.readOnly)

/** Saves a listed file. Turning valid Spec Kit markers into broken ones needs `force` (the renderer confirms first). */
export async function writeConfig(root: string, path: string, content: string, force = false): Promise<void> {
  if (!(await writableItem(root, path))) throw new Error(`Not writable: ${path}`)
  const file = join(root, path)
  const m = readMarkers(root)
  const problem = markerProblem(content, m)
  if (problem && !force && !markerProblem(readFileSync(file, 'utf8'), m)) throw new Error(`MARKERS: ${problem}`)
  writeFileSync(file, content)
}

/** Removes a skill (its whole folder) or a subagent file. */
export async function deleteConfig(root: string, path: string): Promise<void> {
  const item = await writableItem(root, path)
  if (item?.kind !== 'skill' && item?.kind !== 'subagent') throw new Error('Only skills and subagents can be deleted')
  rmSync(join(root, item.kind === 'skill' ? dirname(path) : path), { recursive: true })
}

const yamlValue = (s: string): string => (/^[\s"'[\]{}>|*&!%@`#,?-]|: | #/.test(s) ? JSON.stringify(s) : s)

/** Writes a starter file in the agent's standard location and returns its path. Never overwrites. */
export function createConfig(root: string, kind: ConfigKind, agent: ConfigAgent, name: string, description: string): string {
  const loc = LOCATIONS[agent]?.[kind]
  if (!loc) throw new Error(`${agent} has no ${kind} location`)
  if (kind !== 'context' && !name.trim()) throw new Error('Name is required')
  const slug = slugify(name)
  const desc = description.replace(/\s+/g, ' ').trim()
  const path = kind === 'context' ? loc : kind === 'skill' ? `${loc}/${slug}/SKILL.md` : `${loc}/${slug}.md`
  const file = assertWritable(root, path)
  if (existsSync(file)) throw new Error(`${kind} "${kind === 'context' ? loc : slug}" already exists for ${agent}`)
  const fm = `---\nname: ${slug}\ndescription: ${yamlValue(desc)}\n---\n\n`
  const content =
    kind === 'context'
      ? `# ${basename(resolve(root))}\n\n${desc}\n`
      : kind === 'skill'
        ? `${fm}# ${name.trim()}\n\n<!-- Steps the agent should follow -->\n`
        : `${fm}You are ${name.trim()}. <!-- prompt -->\n`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, { flag: 'wx' })
  return path
}

/** "Use one shared file" for the CLAUDE.md/GEMINI.md pair in `dir` (writes AGENTS.md, CLAUDE.md, GEMINI.md). */
export function shareConfig(root: string, dir: string): { moved: string[] } {
  const [claude, gemini, agents] = ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md'].map((f) => assertWritable(root, relIn(dir, f)))
  if (!existsSync(claude) || !existsSync(gemini)) throw new Error(`${relIn(dir, '')} needs both CLAUDE.md and GEMINI.md`)
  const out = shareSections({ claude: readFileSync(claude, 'utf8'), gemini: readFileSync(gemini, 'utf8'), agents: existsSync(agents) ? readFileSync(agents, 'utf8') : '' }, readMarkers(root))
  writeFileSync(agents, out.agents)
  writeFileSync(claude, out.claude)
  writeFileSync(gemini, out.gemini)
  return { moved: out.moved }
}

// --- optimize runs

export function optimizePrompt(targets: string[], findings: Finding[], instructions: string, m = DEFAULT_MARKERS): string {
  const list = (xs: string[]): string => (xs.length ? xs.join('\n') : '- none')
  return [
    'Optimize the agent configuration of this project.',
    `Files:\n${list(targets.map((t) => `- ${t}`))}`,
    `Health findings:\n${list(findings.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ''} ${f.rule}: ${f.reason} Fix: ${f.fix}`))}`,
    `Instructions from the user:\n${instructions.trim() || '- none'}`,
    'Goals: make the files shorter and clearer, fix the findings, add missing project facts you can verify in this repository, ' +
      'and keep CLAUDE.md and GEMINI.md aligned (shared instructions go to AGENTS.md, imported with an `@AGENTS.md` line).\n' +
      `Do not change the text between ${m.start} and ${m.end}. Only edit the files listed above.`
  ].join('\n\n')
}

/** Before-run contents of the targets (plus the root context files for whole-project runs); `null` = missing. Large files are left out. */
export function baselineFor(root: string, targets: string[], wholeProject: boolean): Record<string, string | null> {
  const paths = new Set([...targets, ...(wholeProject ? ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md'] : [])])
  return Object.fromEntries(
    [...paths].flatMap((p): [string, string | null][] => {
      const f = join(root, p)
      if (!existsSync(f)) return [[p, null]]
      return statSync(f).size > LARGE ? [] : [[p, readFileSync(f, 'utf8')]]
    })
  )
}

const toLines = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))

// ponytail: O(n·m) LCS table – fine for config files (flagged above 300 lines); use a Myers diff if large files need it.
export function lineDiff(a: string, b: string): FileChange['lines'] {
  const x = toLines(a)
  const y = toLines(b)
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1))
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: FileChange['lines'] = []
  let i = 0
  let j = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) out.push({ op: ' ', text: x[(j++, i++)] })
    else if (j >= y.length || (i < x.length && lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ op: '-', text: x[i++] })
    else out.push({ op: '+', text: y[j++] })
  }
  return out
}

/** Files whose content now differs from the run's baseline. */
export function fileChanges(root: string, baseline: Record<string, string | null>): FileChange[] {
  return Object.entries(baseline).flatMap(([path, before]): FileChange[] => {
    const f = join(root, path)
    if (existsSync(f) && statSync(f).size > LARGE) return [{ path, status: 'too-large', lines: [] }]
    const after = existsSync(f) ? readFileSync(f, 'utf8') : null
    if (after === before) return []
    return [{ path, status: before === null ? 'created' : after === null ? 'deleted' : 'modified', lines: lineDiff(before ?? '', after ?? '') }]
  })
}
