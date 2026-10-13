import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  baselineFor,
  configState,
  createConfig,
  createSkillFile,
  deleteConfig,
  deleteSkillFile,
  fileChanges,
  frontmatter,
  lineDiff,
  listConfig,
  managedBlocks,
  markerProblem,
  optimizePrompt,
  projectFiles,
  readMarkers,
  sectionDiff,
  sections,
  shareSections,
  writeConfig
} from '../src/main/agentconfig.ts'
import type { ConfigItem, Finding } from '../src/shared/types.ts'

const FIXTURE = join(import.meta.dirname, 'fixtures/agent-config-repo')
const M = { start: '<!-- SPECKIT START -->', end: '<!-- SPECKIT END -->' }
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

/** Temp copy of the fixture. Files this repo's own .gitignore drops (dist/, node_modules/, .env) are planted here. */
function copyFixture({ git = false } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentcfg-'))
  cpSync(FIXTURE, dir, { recursive: true })
  for (const f of ['dist/CLAUDE.md', 'node_modules/x/CLAUDE.md']) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    writeFileSync(join(dir, f), '# Ignored\n\nSee `src/nope.ts`.\n')
  }
  writeFileSync(join(dir, '.env'), 'X=1\n')
  if (git) {
    sh(dir, 'init', '-q')
    sh(dir, 'add', '-A')
    sh(dir, 'add', '-f', 'dist/CLAUDE.md') // tracked but ignored: exercises the `-ci` set difference
    sh(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture')
  }
  return dir
}

/** sha1 over every relative path, content and mtime below `dir` (SC-005: browsing writes nothing). */
function treeHash(dir: string): string {
  const h = createHash('sha1')
  const walk = (rel: string): void => {
    for (const d of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(rel, d.name)
      if (d.isDirectory()) walk(p)
      else h.update(`${p}\0${readFileSync(join(dir, p))}\0${statSync(join(dir, p)).mtimeMs}\0`)
    }
  }
  walk('')
  return h.digest('hex')
}

const read = (dir: string, f: string): string => readFileSync(join(dir, f), 'utf8')
const brief = (i: ConfigItem): string => `${i.path} ${i.kind} ${i.agent} ${i.name}`
const key = (f: Finding): string => `${f.file}:${f.line ?? ''} ${f.rule}`

// --- frontmatter and markers

test('frontmatter: quoted values, block scalars, nested maps skipped, broken and missing blocks', () => {
  const md = "---\nname: \"a b\"\ndescription: >\n  folded\n  text\nnotes: |\n  kept\nmetadata:\n  author: x\ntitle: 'q'\n---\nbody"
  assert.deepEqual(frontmatter(md), { ok: true, data: { name: 'a b', description: 'folded text', notes: 'kept', title: 'q' }, bodyStart: 11 })
  assert.equal(frontmatter('---\nname: x\nbody').ok, false)
  assert.deepEqual(frontmatter('# No frontmatter'), { ok: false, data: {}, bodyStart: 0 })
})

test('markers: managed ranges and every kind of breakage', () => {
  const ok = 'a\n<!-- SPECKIT START -->\nx\n<!-- SPECKIT END -->\nb\n<!-- SPECKIT START -->\n<!-- SPECKIT END -->'
  assert.deepEqual(managedBlocks(ok, M), [{ start: 2, end: 4 }, { start: 6, end: 7 }])
  assert.equal(markerProblem(ok, M), undefined)
  assert.equal(markerProblem('no markers', M), undefined)
  assert.match(markerProblem('<!-- SPECKIT START -->\nx', M)!, /line 1 has no matching end/)
  assert.match(markerProblem('<!-- SPECKIT END -->\n<!-- SPECKIT START -->', M)!, /line 1 has no matching start/)
  assert.match(markerProblem('<!-- SPECKIT START -->\n<!-- SPECKIT START -->\n<!-- SPECKIT END -->', M)!, /Nested/)
})

test('readMarkers: agent-context config, else the defaults', () => {
  const dir = copyFixture()
  assert.deepEqual(readMarkers(dir), M)
  mkdirSync(join(dir, '.specify/extensions/agent-context'), { recursive: true })
  writeFileSync(join(dir, '.specify/extensions/agent-context/agent-context-config.yml'), 'context_markers:\n  start: "<!-- A -->"\n  end: <!-- B -->\n')
  assert.deepEqual(readMarkers(dir), { start: '<!-- A -->', end: '<!-- B -->' })
})

// --- discovery (US1)

test('discovery in a git repo: locations, frontmatter, gitignore, node_modules; listing writes nothing', async () => {
  const dir = copyFixture({ git: true })
  const before = treeHash(dir)
  const { files, isRepo } = await projectFiles(dir)
  assert.equal(isRepo, true)
  const items = listConfig(dir, files)
  assert.deepEqual(items.map(brief).sort(), [
    '.claude/agents/helper.md subagent claude helper',
    '.claude/skills/review-2/SKILL.md skill claude review',
    '.claude/skills/review/SKILL.md skill claude review',
    '.claude/skills/vague/SKILL.md skill claude vague',
    '.gemini/skills/g/SKILL.md skill gemini g',
    'CLAUDE.md context claude CLAUDE.md',
    'GEMINI.md context gemini GEMINI.md',
    'pkg/CLAUDE.md context claude pkg/CLAUDE.md'
  ])
  const by = (p: string): ConfigItem => items.find((i) => i.path === p)!
  assert.equal(by('.claude/agents/helper.md').description, 'Helps')
  assert.equal(by('.claude/skills/review/SKILL.md').description, 'Reviews the current diff for bugs and style problems before a commit.')
  assert.equal(by('.claude/skills/review-2/SKILL.md').description, undefined)
  assert.match(by('.gemini/skills/g/SKILL.md').description!, /^Gemini skill description sentence number 1 that is long\. Gemini/)
  assert.deepEqual(by('.claude/skills/review/SKILL.md').extraFiles, ['scripts/run.sh'])
  assert.deepEqual(by('.claude/skills/vague/SKILL.md').extraFiles, [])
  assert.deepEqual(by('CLAUDE.md').managed, [{ start: 20, end: 22 }])
  assert.ok(items.every((i) => !i.readOnly && i.size > 0 && i.mtime > 0))
  await configState(dir)
  assert.equal(treeHash(dir), before)
})

test('discovery without git still skips node_modules, and a symlinked skill is read-only', async () => {
  const dir = copyFixture()
  const outside = mkdtempSync(join(tmpdir(), 'outside-'))
  writeFileSync(join(outside, 'SKILL.md'), '---\nname: linked\ndescription: A skill that lives somewhere else.\n---\n')
  symlinkSync(outside, join(dir, '.claude/skills/linked'))
  const { files, isRepo } = await projectFiles(dir)
  assert.equal(isRepo, false)
  assert.ok(files.includes('dist/CLAUDE.md')) // no gitignore outside git
  assert.ok(!files.some((f) => f.startsWith('node_modules/')))
  const items = listConfig(dir, files)
  assert.ok(!items.some((i) => i.path.startsWith('node_modules/')))
  const linked = items.find((i) => i.name === 'linked')!
  assert.equal(linked.readOnly, true)
  await assert.rejects(writeConfig(dir, linked.path, 'x'), /Not writable/)
  await assert.rejects(deleteConfig(dir, linked.path), /Only skills and subagents/)
  assert.ok(existsSync(join(outside, 'SKILL.md')))
})

test('configState: items, isRepo and section diffs in one read', async () => {
  const s = await configState(copyFixture({ git: true }))
  assert.equal(s.items.length, 8)
  assert.equal(s.isRepo, true)
  assert.deepEqual(s.sync.map((d) => d.dir), [''])
})

// --- create, edit, delete (US2)

test('createConfig: templates per kind and agent; duplicates and bad input are refused', () => {
  const dir = copyFixture()
  assert.equal(createConfig(dir, 'skill', 'claude', 'Release Notes', 'Write release notes from merged PRs'), '.claude/skills/release-notes/SKILL.md')
  assert.equal(
    read(dir, '.claude/skills/release-notes/SKILL.md'),
    '---\nname: release-notes\ndescription: Write release notes from merged PRs\n---\n\n# Release Notes\n\n<!-- Steps the agent should follow -->\n'
  )
  assert.throws(() => createConfig(dir, 'skill', 'claude', 'release notes', 'x'), /skill "release-notes" already exists for claude/)
  assert.equal(createConfig(dir, 'skill', 'gemini', 'release notes', 'Fix: quoted when needed'), '.gemini/skills/release-notes/SKILL.md')
  assert.equal(frontmatter(read(dir, '.gemini/skills/release-notes/SKILL.md')).data.description, 'Fix: quoted when needed')
  assert.equal(createConfig(dir, 'subagent', 'claude', 'Tester', 'Runs the tests'), '.claude/agents/tester.md')
  assert.equal(read(dir, '.claude/agents/tester.md'), '---\nname: tester\ndescription: Runs the tests\n---\n\nYou are Tester. <!-- prompt -->\n')
  assert.equal(createConfig(dir, 'context', 'shared', '', 'Shared rules.'), 'AGENTS.md')
  assert.equal(read(dir, 'AGENTS.md'), `# ${basename(dir)}\n\nShared rules.\n`)
  const before = read(dir, 'CLAUDE.md')
  assert.throws(() => createConfig(dir, 'context', 'claude', '', 'x'), /context "CLAUDE.md" already exists for claude/)
  assert.equal(read(dir, 'CLAUDE.md'), before)
  assert.throws(() => createConfig(dir, 'subagent', 'gemini', 'x', 'y'), /gemini has no subagent location/)
  assert.throws(() => createConfig(dir, 'skill', 'claude', '  ', 'y'), /Name is required/)
})

test('writeConfig: only listed writable paths; breaking the Spec Kit markers needs force', async () => {
  const dir = copyFixture()
  for (const p of ['nope.md', '../x.md', 'src/main.ts', '/etc/hosts']) await assert.rejects(writeConfig(dir, p, 'x'), /Not writable/)
  const broken = read(dir, 'CLAUDE.md').replace('<!-- SPECKIT END -->\n', '')
  await assert.rejects(writeConfig(dir, 'CLAUDE.md', broken), /MARKERS: .*no matching end/)
  assert.notEqual(read(dir, 'CLAUDE.md'), broken)
  await writeConfig(dir, 'CLAUDE.md', broken, true)
  assert.equal(read(dir, 'CLAUDE.md'), broken)
  await writeConfig(dir, 'pkg/CLAUDE.md', '<!-- SPECKIT START -->\nstill broken\n') // already broken before: no confirm
  await writeConfig(dir, '.claude/skills/vague/SKILL.md', '---\nname: vague\ndescription: Says what it does and when.\n---\n')
})

test('deleteConfig: the whole skill folder, a subagent file, never a context file', async () => {
  const dir = copyFixture()
  await deleteConfig(dir, '.claude/skills/review/SKILL.md')
  assert.equal(existsSync(join(dir, '.claude/skills/review')), false)
  await deleteConfig(dir, '.claude/agents/helper.md')
  assert.equal(existsSync(join(dir, '.claude/agents/helper.md')), false)
  await assert.rejects(deleteConfig(dir, 'CLAUDE.md'), /Only skills and subagents can be deleted/)
  assert.ok(existsSync(join(dir, 'CLAUDE.md')))
})

test('auxiliary skill files: create, list, edit, delete; traversal, SKILL.md and read-only skills refused', async () => {
  const dir = copyFixture()
  const skill = '.claude/skills/review'
  assert.equal(await createSkillFile(dir, skill, 'templates/story.md', '# Story\n'), `${skill}/templates/story.md`)
  await assert.rejects(createSkillFile(dir, skill, 'templates/story.md', 'x'), /EEXIST/)
  for (const bad of ['../escape.sh', '../../CLAUDE.md', 'SKILL.md', '/etc/x', ' ', 'a/../../b'])
    await assert.rejects(createSkillFile(dir, skill, bad, 'x'), /Invalid file name/)
  await assert.rejects(createSkillFile(dir, '.claude/skills/nope', 'a.sh', 'x'), /No writable skill/)
  await assert.rejects(createSkillFile(dir, 'src', 'a.sh', 'x'), /No writable skill/)
  const { files } = await projectFiles(dir)
  assert.deepEqual(listConfig(dir, files).find((i) => i.path === `${skill}/SKILL.md`)!.extraFiles, ['scripts/run.sh', 'templates/story.md'])

  await writeConfig(dir, `${skill}/scripts/run.sh`, '#!/bin/sh\necho hi\n')
  assert.equal(read(dir, `${skill}/scripts/run.sh`), '#!/bin/sh\necho hi\n')
  await assert.rejects(writeConfig(dir, `${skill}/scripts/new.sh`, 'x'), /Not writable/) // only existing files; create goes through createSkillFile

  await deleteSkillFile(dir, `${skill}/templates/story.md`)
  assert.equal(existsSync(join(dir, skill, 'templates/story.md')), false)
  assert.ok(existsSync(join(dir, skill, 'SKILL.md')))
  await assert.rejects(deleteSkillFile(dir, `${skill}/SKILL.md`), /Not an auxiliary/)
  await assert.rejects(deleteSkillFile(dir, 'CLAUDE.md'), /Not an auxiliary/)

  // a skill symlinked from outside stays untouched
  const outside = mkdtempSync(join(tmpdir(), 'outside-'))
  writeFileSync(join(outside, 'SKILL.md'), '---\nname: linked\ndescription: Lives somewhere else entirely.\n---\n')
  writeFileSync(join(outside, 'x.sh'), 'x')
  symlinkSync(outside, join(dir, '.claude/skills/linked'))
  await assert.rejects(createSkillFile(dir, '.claude/skills/linked', 'y.sh', 'y'), /No writable skill/)
  await assert.rejects(writeConfig(dir, '.claude/skills/linked/x.sh', 'changed'), /Not writable/)
  await assert.rejects(deleteSkillFile(dir, '.claude/skills/linked/x.sh'), /Not an auxiliary/)
  assert.equal(readFileSync(join(outside, 'x.sh'), 'utf8'), 'x')
})

test('.mcp.json: raw edits must be valid JSON; MCP findings and servers are part of configState', async () => {
  const dir = copyFixture()
  await assert.rejects(writeConfig(dir, '.mcp.json', '{ broken'), /Invalid JSON/)
  await writeConfig(dir, '.mcp.json', '{ "mcpServers": { "x": { "args": [] } } }')
  const s = await configState(dir)
  assert.deepEqual(s.mcp, { servers: [{ name: 'x', args: [] }], exists: true })
  assert.deepEqual(s.findings.filter((f) => f.file === '.mcp.json').map((f) => `${f.server} ${f.rule}`), ['x mcp-missing-command'])
})

// --- health (US3)

test('health check finds exactly the planted problems and no existing path', async () => {
  const { findings } = await configState(copyFixture({ git: true }))
  assert.deepEqual(findings.map(key).sort(), [
    '.claude/skills/review-2/SKILL.md: duplicate-name',
    '.claude/skills/review-2/SKILL.md: missing-description',
    '.claude/skills/review/SKILL.md: duplicate-name',
    '.claude/skills/vague/SKILL.md: vague-description',
    '.gemini/skills/g/SKILL.md: long-description',
    'CLAUDE.md:15 missing-reference',
    'CLAUDE.md:16 missing-reference',
    'CLAUDE.md:18 missing-reference',
    'CLAUDE.md:6 section-conflict',
    'CLAUDE.md:9 missing-reference',
    'GEMINI.md:6 section-conflict',
    'pkg/CLAUDE.md: too-long',
    'pkg/CLAUDE.md:1 broken-markers'
  ])
  const reasons = findings.filter((f) => f.rule === 'missing-reference').map((f) => f.reason).join('\n')
  for (const t of ['npm run lint', 'src/old.ts', 'docs/gone.md', '@missing.md']) assert.ok(reasons.includes(t), t)
  assert.ok(findings.every((f) => f.reason && f.fix && f.severity))
})

test('health: frontmatter rules, fixes disappear on the next read, large files only get too-long', async () => {
  const dir = copyFixture({ git: true })
  mkdirSync(join(dir, '.claude/skills/nofm'))
  writeFileSync(join(dir, '.claude/skills/nofm/SKILL.md'), '# No frontmatter\n')
  writeFileSync(join(dir, '.claude/agents/anon.md'), '---\ndescription: Does a thing for you.\n---\n')
  writeFileSync(join(dir, '.claude/agents/open.md'), '---\nname: open\n')
  writeFileSync(join(dir, 'CLAUDE.md'), read(dir, 'CLAUDE.md').replace('`src/old.ts`', '`src/main.ts`'))
  writeFileSync(join(dir, 'GEMINI.md'), `${'See `src/old.ts`.\n'.repeat(60_000)}`)
  const keys = (await configState(dir)).findings.map(key)
  for (const k of ['.claude/skills/nofm/SKILL.md: bad-frontmatter', '.claude/agents/anon.md: missing-name', '.claude/agents/open.md: bad-frontmatter', 'GEMINI.md: too-long'])
    assert.ok(keys.includes(k), k)
  assert.ok(!keys.some((k) => /^CLAUDE\.md:15 /.test(k)))
  assert.ok(!keys.some((k) => k.startsWith('GEMINI.md') && !k.endsWith('too-long')))
})

// --- sync (US5)

test('sections and sectionDiff: drift, conflicts, whitespace, repeated headings, managed blocks', () => {
  assert.deepEqual(
    sections('pre\n# N\na\n# N\nb\n```\n# not a heading\n```\n').map((s) => [s.heading, s.line]),
    [['', 1], ['N', 2], ['N (2)', 4]]
  )
  const same = '# A\n\nx\n\n# B\n<!-- SPECKIT START -->\nm\n<!-- SPECKIT END -->\n'
  assert.deepEqual(sectionDiff(same, same, '', M), { dir: '', drift: [], conflicts: [], shared: ['A'] })
  assert.deepEqual(sectionDiff(read(FIXTURE, 'CLAUDE.md'), read(FIXTURE, 'GEMINI.md'), '', M), {
    dir: '',
    drift: [{ heading: 'Claude only', only: 'claude' }, { heading: 'Gemini only', only: 'gemini' }],
    conflicts: [{ heading: 'Commands', claudeLine: 6, geminiLine: 6 }],
    shared: ['Style']
  })
})

const norm = (t: string): string => t.replace(/\s+/g, ' ').trim()
const holds = (out: string, text: string): boolean => sections(out).some((s) => norm(s.text) === norm(text))

test('shareSections moves identical sections to AGENTS.md and loses nothing', () => {
  const claude = read(FIXTURE, 'CLAUDE.md')
  const gemini = read(FIXTURE, 'GEMINI.md')
  const out = shareSections({ claude, gemini, agents: '' }, M)
  assert.deepEqual(out.moved, ['Style'])
  assert.match(out.agents, /^## Style\n\nUse {3}two spaces\.\nPrefer small functions\.\n$/)
  for (const f of [out.claude, out.gemini]) {
    assert.ok(f.startsWith('@AGENTS.md\n'))
    assert.equal(f.split('\n').filter((l) => l.trim() === '@AGENTS.md').length, 1)
    assert.ok(!f.includes('## Style'))
  }
  assert.ok(out.claude.includes('<!-- SPECKIT START -->\nManaged by Spec Kit.\n<!-- SPECKIT END -->'))
  for (const [input, own] of [[claude, out.claude], [gemini, out.gemini]])
    for (const s of sections(input).filter((s) => norm(s.text))) assert.equal([own, out.agents].filter((o) => holds(o, s.text)).length, 1, s.heading)
})

test('shareSections keeps an existing AGENTS.md and does not duplicate a section it already has', () => {
  const agents = '# Shared\n\nKeep this.\n\n## Style\n\nUse two spaces.\nPrefer small functions.\n'
  const once = shareSections({ claude: `@AGENTS.md\n\n${read(FIXTURE, 'CLAUDE.md')}`, gemini: read(FIXTURE, 'GEMINI.md'), agents }, M)
  assert.equal(once.agents, agents)
  assert.equal(once.claude.split('\n').filter((l) => l.trim() === '@AGENTS.md').length, 1)
  assert.throws(() => shareSections(once, M), /No identical sections/)
})

// --- optimize (US4)

test('optimizePrompt lists the files, all of their findings and the instructions', () => {
  const f: Finding = { file: 'CLAUDE.md', line: 12, rule: 'missing-reference', severity: 'error', reason: '`src/old.ts` does not exist.', fix: 'Update or remove the reference.' }
  const p = optimizePrompt(['CLAUDE.md'], [f, { ...f, line: undefined, rule: 'too-long', reason: 'Too long.', fix: 'Shorten it.' }], ' shorten it ')
  assert.ok(
    p.startsWith(
      'Optimize the agent configuration of this project.\n\nFiles:\n- CLAUDE.md\n\nHealth findings:\n' +
        '- CLAUDE.md:12 missing-reference: `src/old.ts` does not exist. Fix: Update or remove the reference.\n' +
        '- CLAUDE.md too-long: Too long. Fix: Shorten it.\n\nInstructions from the user:\nshorten it\n\nGoals: '
    ),
    p
  )
  assert.match(p, /Do not change the text between <!-- SPECKIT START --> and <!-- SPECKIT END -->\. Only edit the files listed above\.$/)
  assert.match(optimizePrompt(['A.md'], [], ''), /Health findings:\n- none\n\nInstructions from the user:\n- none/)
})

test('lineDiff: unchanged, removed and added lines', () => {
  assert.deepEqual(lineDiff('a\nb\nc\n', 'a\nc\nd\n'), [
    { op: ' ', text: 'a' },
    { op: '-', text: 'b' },
    { op: ' ', text: 'c' },
    { op: '+', text: 'd' }
  ])
  assert.deepEqual(lineDiff('', 'x\n'), [{ op: '+', text: 'x' }])
})

test('baselineFor + fileChanges: modified, created, deleted; unchanged files left out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'changes-'))
  writeFileSync(join(dir, 'a.md'), 'x\n')
  writeFileSync(join(dir, 'b.md'), 'same\n')
  writeFileSync(join(dir, 'CLAUDE.md'), 'gone\n')
  const baseline = baselineFor(dir, ['a.md', 'b.md'], true)
  assert.deepEqual(baseline, { 'a.md': 'x\n', 'b.md': 'same\n', 'CLAUDE.md': 'gone\n', 'GEMINI.md': null, 'AGENTS.md': null })
  assert.deepEqual(baselineFor(dir, ['a.md'], false), { 'a.md': 'x\n' })
  writeFileSync(join(dir, 'a.md'), 'x\ny\n')
  writeFileSync(join(dir, 'AGENTS.md'), 'new\n')
  execFileSync('rm', [join(dir, 'CLAUDE.md')])
  assert.deepEqual(fileChanges(dir, baseline), [
    { path: 'a.md', status: 'modified', lines: [{ op: ' ', text: 'x' }, { op: '+', text: 'y' }] },
    { path: 'CLAUDE.md', status: 'deleted', lines: [{ op: '-', text: 'gone' }] },
    { path: 'AGENTS.md', status: 'created', lines: [{ op: '+', text: 'new' }] }
  ])
})
