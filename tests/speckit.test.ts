import { test } from 'node:test'
import assert from 'node:assert/strict'
import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import { backlinks, draftMarkdown, listWiki, listWorkItems, nextSpecPrefix, nextWorkItemKey, parseTasks, parseWorkItem, readProject, readSpec, setTaskDone, workItemMarkdown } from '../src/main/speckit.ts'
import { mkdtempSync, cpSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const repo = join(import.meta.dirname, 'fixtures/sample-repo')

test('derives a phase for every spec from files', () => {
  const p = readProject(repo)
  assert.equal(p.initialized, true)
  assert.deepEqual(
    Object.fromEntries(p.specs.map((s) => [s.key, s.phase])),
    {
      '001-draft': 'draft',
      '002-specified': 'specified',
      '003-clarified': 'clarified',
      '004-planned': 'planned',
      '005-implementing': 'implementing',
      '006-done': 'done',
      '007-captured-idea': 'draft'
    }
  )
})

test('reads title, number, open clarifications and artifacts', () => {
  const specs = readProject(repo).specs
  const s2 = specs.find((s) => s.key === '002-specified')!
  assert.equal(s2.title, 'Photo Albums')
  assert.equal(s2.number, '002')
  assert.equal(s2.openClarifications, 2)
  const s4 = specs.find((s) => s.key === '004-planned')!
  assert.deepEqual(
    s4.artifacts.map((a) => a.file),
    ['spec.md', 'plan.md', 'research.md', 'contracts/api.md']
  )
  assert.equal(specs.find((s) => s.key === '001-draft')!.title, 'draft')
})

test('reads integration command prefix and constitution', () => {
  const p = readProject(repo)
  assert.equal(p.integration, 'claude')
  assert.equal(p.commandPrefix, '/speckit-')
  const { mtime, ...c } = p.constitution!
  assert.ok(mtime)
  assert.deepEqual(c, { version: '2.1.0', ratified: '2026-01-01', amended: '2026-09-30' })
})

test('ignores clarification markers quoted in code', () => {
  const s = readProject(repo).specs.find((x) => x.key === '003-clarified')!
  assert.equal(s.openClarifications, 0)
})

test('parses tasks tolerantly', () => {
  const tasks = parseTasks(
    '## Phase 1: Setup\n- [X] T001 A\n- [x] T002 [P] B\n## Phase 3: US1\n- [ ] T003 [P] [US1] C in src/a.ts\n-  [ ]  T004 [US1] D\n- [ ] no id\n'
  )
  assert.deepEqual(tasks, [
    { id: 'T001', done: true, parallel: false, story: undefined, text: 'A', section: 'Phase 1: Setup' },
    { id: 'T002', done: true, parallel: true, story: undefined, text: 'B', section: 'Phase 1: Setup' },
    { id: 'T003', done: false, parallel: true, story: 'US1', text: 'C in src/a.ts', section: 'Phase 3: US1' },
    { id: 'T004', done: false, parallel: false, story: 'US1', text: 'D', section: 'Phase 3: US1' }
  ])
})

test('marks downstream artifacts stale when upstream is newer', () => {
  const dir = join(repo, 'specs/004-planned')
  utimesSync(join(repo, '.specify/memory/constitution.md'), 500, 500)
  utimesSync(join(dir, 'plan.md'), 1000, 1000)
  utimesSync(join(dir, 'spec.md'), 2000, 2000)
  const plan = readProject(repo).specs.find((s) => s.key === '004-planned')!.artifacts.find((a) => a.file === 'plan.md')!
  assert.equal(plan.stale, true)
  utimesSync(join(dir, 'plan.md'), 3000, 3000)
  const fresh = readProject(repo).specs.find((s) => s.key === '004-planned')!.artifacts.find((a) => a.file === 'plan.md')!
  assert.equal(fresh.stale, false)
})

test('handles missing and uninitialized folders', () => {
  assert.equal(readProject(join(repo, 'nope')).missing, true)
  assert.equal(readProject(join(repo, 'specs')).initialized, false)
})

test('setTaskDone toggles only the matching task line', () => {
  const md = '## P1\n- [ ] T001 A\n- [X] T002 B\n  - [ ] T010 nested\n- [ ] T0011 not T001\n'
  assert.equal(setTaskDone(md, 'T001', true), '## P1\n- [X] T001 A\n- [X] T002 B\n  - [ ] T010 nested\n- [ ] T0011 not T001\n')
  assert.equal(setTaskDone(md, 'T002', false), '## P1\n- [ ] T001 A\n- [ ] T002 B\n  - [ ] T010 nested\n- [ ] T0011 not T001\n')
  assert.equal(setTaskDone(md, 'T999', true), undefined)
})

test('plan is stale when the constitution is newer', () => {
  const dir = join(repo, 'specs/004-planned')
  utimesSync(join(dir, 'spec.md'), 1000, 1000)
  utimesSync(join(dir, 'plan.md'), 2000, 2000)
  utimesSync(join(repo, '.specify/memory/constitution.md'), 3000, 3000)
  const p = readProject(repo)
  assert.equal(p.constitution?.mtime, 3000 * 1000)
  assert.equal(p.specs.find((s) => s.key === '004-planned')!.artifacts.find((a) => a.file === 'plan.md')!.stale, true)
  utimesSync(join(repo, '.specify/memory/constitution.md'), 500, 500)
})

test('lists wiki pages and finds backlinks in wiki and specs', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-'))
  cpSync(repo, root, { recursive: true })
  mkdirSync(join(root, 'docs/wiki/ops'), { recursive: true })
  writeFileSync(join(root, 'docs/wiki/auth-decisions.md'), '# Auth Decisions\n\nWe use OAuth.')
  writeFileSync(join(root, 'docs/wiki/ops/setup.md'), 'No heading, see [[auth decisions]].')
  writeFileSync(join(root, 'specs/003-clarified/research.md'), '# R\n\nSee [[Auth Decisions|why]].')
  const pages = listWiki(root)
  assert.deepEqual(pages, [{ file: 'auth-decisions.md', title: 'Auth Decisions' }, { file: 'ops/setup.md', title: 'setup' }])
  assert.deepEqual(backlinks(root, pages[0]), ['docs/wiki/ops/setup.md', 'specs/003-clarified/research.md'])
  assert.deepEqual(readProject(root).wiki.length, 2)
})

test('reads title and description of a draft from draft.md', () => {
  const specs = readProject(repo).specs
  const d = specs.find((s) => s.key === '007-captured-idea')!
  assert.equal(d.title, 'Captured idea')
  assert.equal(d.description, 'Users can capture an idea before specifying it.')
  const plain = specs.find((s) => s.key === '001-draft')!
  assert.equal(plain.title, 'draft')
  assert.equal(plain.description, undefined)
  assert.equal(specs.find((s) => s.key === '002-specified')!.description, undefined)
})

test('draftMarkdown round-trips through readSpec', () => {
  const root = mkdtempSync(join(tmpdir(), 'draft-'))
  mkdirSync(join(root, 'specs/010-x'), { recursive: true })
  writeFileSync(join(root, 'specs/010-x/draft.md'), draftMarkdown('  Album sharing ', '\nShare albums.\n\nWith a link.  '))
  const s = readSpec(root, 'specs/010-x', '010-x')
  assert.deepEqual([s.phase, s.title, s.description], ['draft', 'Album sharing', 'Share albums.\n\nWith a link.'])
  assert.equal(draftMarkdown('T', '  '), '# T\n')
})

test('nextSpecPrefix: sequential max + 1, timestamps ignored, timestamp scheme', () => {
  assert.equal(nextSpecPrefix(['003-a', '012-b', 'feature/x', '007-c', 'main'], 'sequential', new Date()), '013')
  assert.equal(nextSpecPrefix(['002-a', '20260101-120000-x'], 'sequential', new Date()), '003')
  assert.equal(nextSpecPrefix(['009-x'], 'sequential', new Date()), '010')
  assert.equal(nextSpecPrefix(['1234-x'], 'sequential', new Date()), '1235')
  assert.equal(nextSpecPrefix([], 'sequential', new Date()), '001')
  assert.equal(nextSpecPrefix(['003-a'], 'timestamp', new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405')
})

test('work items: frontmatter round-trip, title edits keep the key, fault-tolerant parsing', () => {
  const md = workItemMarkdown({ title: 'Q4: "Launch" plan', category: 'marketing', status: 'in-progress', body: 'Go to market.' })
  assert.equal(md, '---\ntitle: "Q4: \\"Launch\\" plan"\ncategory: marketing\nstatus: in-progress\n---\n\nGo to market.\n')
  const w = parseWorkItem('WI-001-q4-launch-plan', md, 5)
  assert.deepEqual(
    { ...w },
    { key: 'WI-001-q4-launch-plan', file: 'work-items/WI-001-q4-launch-plan.md', title: 'Q4: "Launch" plan', category: 'marketing', status: 'in-progress', body: 'Go to market.\n', mtime: 5 }
  )
  assert.equal(parseWorkItem('WI-002-x', '---\ntitle: Plain\ncategory: nonsense\n---\nBody').category, 'general')
  assert.equal(parseWorkItem('WI-002-x', '---\ntitle: Plain\nstatus: blocked\n---\nBody').status, 'draft')
  const broken = parseWorkItem('WI-003-y', '---\ntitle: never closed\n# Heading\ntext')
  assert.deepEqual([broken.title, broken.category, broken.status], ['Heading', 'general', 'draft'])
  assert.equal(parseWorkItem('WI-004-z', '').title, 'WI-004-z')
})

test('work items: sequential keys, listing, missing folder', () => {
  assert.equal(nextWorkItemKey([], 'Q4 Marketing Strategy for Europe'), 'WI-001-q4-marketing-strategy-for')
  assert.equal(nextWorkItemKey(['WI-002-a.md', 'WI-010-b.md', 'notes.md'], 'Pricing'), 'WI-011-pricing')
  const dir = mkdtempSync(join(tmpdir(), 'wi-'))
  assert.deepEqual(listWorkItems(dir), [])
  mkdirSync(join(dir, 'work-items'))
  writeFileSync(join(dir, 'work-items/WI-002-b.md'), workItemMarkdown({ title: 'B', category: 'research', status: 'done', body: '' }))
  writeFileSync(join(dir, 'work-items/WI-001-a.md'), '# Just a heading\n')
  writeFileSync(join(dir, 'work-items/readme.txt'), 'ignored')
  assert.deepEqual(listWorkItems(dir).map((w) => [w.key, w.title, w.status]), [['WI-001-a', 'Just a heading', 'draft'], ['WI-002-b', 'B', 'done']])
  assert.deepEqual(readProject(repo).workItems, [])
})

test('studio agent: assigned in .specify/integration.json next to Spec Kit keys, which stay untouched', async () => {
  const { readFileSync } = await import('node:fs')
  const { readIntegration, writeStudioAgent } = await import('../src/main/speckit.ts')
  const dir = mkdtempSync(join(tmpdir(), 'studio-agent-'))
  mkdirSync(join(dir, '.specify'))
  const spec = { integration: 'claude', integration_settings: { claude: { invoke_separator: '-' } }, installed_integrations: ['claude'] }
  writeFileSync(join(dir, '.specify/integration.json'), JSON.stringify(spec))
  assert.deepEqual(readIntegration(dir), { integration: 'claude', commandPrefix: '/speckit-' }) // inherited
  writeStudioAgent(dir, 'antigravity-acp')
  assert.deepEqual(readIntegration(dir), { integration: 'claude', studioAgent: 'antigravity-acp', commandPrefix: '/speckit-' })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.specify/integration.json'), 'utf8')), { ...spec, studio_agent: 'antigravity-acp' })
  assert.equal(readProject(dir).studioAgent, 'antigravity-acp')
  writeStudioAgent(dir, null)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.specify/integration.json'), 'utf8')), spec)
  // no integration.json yet: created; not a Spec Kit project: refused
  const fresh = mkdtempSync(join(tmpdir(), 'studio-agent-'))
  mkdirSync(join(fresh, '.specify'))
  writeStudioAgent(fresh, 'fake')
  assert.equal(readIntegration(fresh).studioAgent, 'fake')
  assert.throws(() => writeStudioAgent(mkdtempSync(join(tmpdir(), 'plain-')), 'fake'), /Not a Spec Kit project/)
})
