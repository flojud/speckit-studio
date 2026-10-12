import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPm, boardColumns, computeDashboardMetrics, dayKey, epicProgress, milestoneStatus, monthGrid, roadmapGrid } from '../src/shared/pm.ts'
import type { Spec, WorkItem } from '../src/shared/types.ts'

const spec = (key: string, phase: Spec['phase'], done = 0, total = 0): Spec => ({
  key, number: key.slice(0, 3), title: key, phase, artifacts: [], openClarifications: 0,
  tasks: Array.from({ length: total }, (_, i) => ({ id: `T${i}`, done: i < done, parallel: false, text: '', section: '' }))
})
const wi = (key: string, status: WorkItem['status']): WorkItem => ({ key, file: `work-items/${key}.md`, title: key, category: 'marketing', status, body: '', mtime: 0 })

test('applyPm assigns epics/milestones and derives blocked from blocker phases', () => {
  const specs = [spec('001-a', 'done'), spec('002-b', 'planned'), spec('003-c', 'tasked'), spec('004-d', 'tasked')]
  applyPm(specs, {
    epics: [], milestones: [],
    meta: [{ specKey: '003-c', epicId: 1, milestoneId: 2 }],
    deps: [
      { specKey: '003-c', blockedBy: '001-a' },
      { specKey: '003-c', blockedBy: '002-b' },
      { specKey: '004-d', blockedBy: '001-a' },
      { specKey: '004-d', blockedBy: '999-gone' }
    ]
  })
  const [, b, c, d] = specs
  assert.deepEqual([c.epicId, c.milestoneId, c.blockedBy, c.blocked], [1, 2, ['001-a', '002-b'], true])
  assert.deepEqual([d.blockedBy, d.blocked], [['001-a', '999-gone'], false])
  assert.deepEqual([b.epicId, b.blockedBy, b.blocked], [null, [], false])
})

test('roadmapGrid places specs by epic row and milestone column, with fallbacks', () => {
  const specs = [spec('001-a', 'done'), spec('002-b', 'planned'), spec('003-c', 'tasked')]
  applyPm(specs, { epics: [], milestones: [], meta: [{ specKey: '001-a', epicId: 1, milestoneId: 10 }, { specKey: '002-b', epicId: 1, milestoneId: null }], deps: [] })
  const g = roadmapGrid(specs, [{ id: 1, title: 'Auth', goal: '' }], [{ id: 10, title: 'v1', due: null }])
  assert.deepEqual(g.columns.map((c) => c?.title ?? null), ['v1', null])
  assert.deepEqual(g.rows.map((r) => [r.epic?.title ?? null, r.cells.map((c) => c.map((s) => s.key))]), [
    ['Auth', [['001-a'], ['002-b']]],
    [null, [[], ['003-c']]]
  ])
})

test('epicProgress sums tasks and done specs', () => {
  assert.deepEqual(epicProgress([spec('001', 'done', 2, 2), spec('002', 'implementing', 1, 4)]), { tasksDone: 3, tasks: 6, specsDone: 1, specs: 2, done: 1, total: 2 })
})

test('dayKey uses local date parts', () => {
  assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05')
})

test('monthGrid lays out 6×7 weeks with locale week start', () => {
  const oct = (weekStart: number) => monthGrid(2026, 9, weekStart, '2026-10-11', [], [])
  const lead = (g: ReturnType<typeof oct>) => g.weeks[0].filter((d) => !d.inMonth).map((d) => d.date)
  const mon = oct(1)
  assert.equal(mon.weeks.length, 6)
  assert.ok(mon.weeks.every((w) => w.length === 7))
  assert.deepEqual(lead(mon), ['2026-09-28', '2026-09-29', '2026-09-30'])
  assert.equal(lead(oct(7)).length, 4)
  assert.equal(lead(monthGrid(2026, 10, 1, '2026-10-11', [], [])).length, 6)
  assert.deepEqual(mon.weeks.flat().filter((d) => d.today).map((d) => d.date), ['2026-10-11'])
})

test('monthGrid places milestones by due day, in order, with unscheduled', () => {
  const specs = [spec('001-a', 'done'), spec('002-b', 'planned')]
  applyPm(specs, { epics: [], milestones: [], meta: [{ specKey: '001-a', epicId: null, milestoneId: 1 }, { specKey: '002-b', epicId: null, milestoneId: 2 }], deps: [] })
  const g = monthGrid(2026, 9, 1, '2026-10-11', specs, [
    { id: 1, title: 'Edge', due: '2026-09-30' },
    { id: 2, title: 'A', due: '2026-10-20' },
    { id: 3, title: 'B', due: '2026-10-20' },
    { id: 4, title: 'Far', due: '2027-01-01' },
    { id: 5, title: 'Later', due: null }
  ])
  const days = g.weeks.flat()
  const at = (date: string) => days.find((d) => d.date === date)!
  assert.deepEqual([at('2026-09-30').inMonth, at('2026-09-30').milestones.map((m) => m.milestone.title)], [false, ['Edge']])
  assert.deepEqual(at('2026-09-30').milestones[0].specs.map((s) => s.key), ['001-a'])
  assert.deepEqual(at('2026-10-20').milestones.map((m) => m.milestone.title), ['A', 'B'])
  assert.ok(!days.some((d) => d.milestones.some((m) => ['Far', 'Later'].includes(m.milestone.title))))
  assert.deepEqual(g.unscheduled.map((m) => m.milestone.title), ['Later'])
})

test('milestoneStatus counts done specs and flags overdue', () => {
  const today = '2026-10-11'
  assert.deepEqual(milestoneStatus([spec('001', 'done'), spec('002', 'planned')], '2026-10-10', today), { done: 1, total: 2, overdue: true })
  assert.equal(milestoneStatus([spec('001', 'done')], '2026-10-10', today).overdue, false)
  assert.deepEqual(milestoneStatus([], '2026-10-10', today), { done: 0, total: 0, overdue: false })
  assert.equal(milestoneStatus([spec('002', 'planned')], today, today).overdue, false)
  assert.equal(milestoneStatus([spec('002', 'planned')], null, today).overdue, false)
})

test('milestone and epic roll-ups count specs and work items equally', () => {
  const today = '2026-10-11'
  assert.deepEqual(milestoneStatus([spec('001', 'done')], '2026-10-10', today, [wi('WI-001', 'review')]), { done: 1, total: 2, overdue: true })
  assert.deepEqual(milestoneStatus([], '2026-10-10', today, [wi('WI-001', 'done')]), { done: 1, total: 1, overdue: false })
  const p = epicProgress([spec('001', 'done'), spec('002', 'tasked')], [wi('WI-001', 'done'), wi('WI-002', 'draft')])
  assert.deepEqual([p.done, p.total, p.specsDone, p.specs], [2, 4, 1, 2])
})

test('applyPm joins work item epic/milestone links', () => {
  const items = [wi('WI-001', 'draft'), wi('WI-002', 'done')]
  applyPm([], { epics: [], milestones: [], meta: [], deps: [], workItemMeta: [{ workItemKey: 'WI-002', epicId: 3, milestoneId: 4 }] }, items)
  assert.deepEqual(items.map((w) => [w.epicId, w.milestoneId]), [[null, null], [3, 4]])
})

test('computeDashboardMetrics: Kanban flow, Scrum milestones, SAFe epics', () => {
  const specs = [spec('001', 'done'), spec('002', 'specified'), spec('003', 'draft'), spec('004', 'implementing')]
  specs[1].openClarifications = 2
  const items = [wi('WI-001', 'in-progress'), wi('WI-002', 'review'), wi('WI-003', 'done')]
  applyPm(specs, { epics: [], milestones: [], meta: [{ specKey: '001', epicId: 1, milestoneId: 10 }, { specKey: '002', epicId: 1, milestoneId: 11 }], deps: [], workItemMeta: [
    { workItemKey: 'WI-001', epicId: 1, milestoneId: 11 },
    { workItemKey: 'WI-003', epicId: null, milestoneId: 10 }
  ] }, items)
  specs[3].blocked = true // applyPm derives blocked from deps; set it afterwards
  const m = computeDashboardMetrics(specs, items, [{ id: 1, title: 'Growth', goal: 'Users' }], [
    { id: 10, title: 'Done one', due: '2026-10-01' },
    { id: 11, title: 'Late', due: '2026-10-01' },
    { id: 12, title: 'Empty', due: null }
  ], '2026-10-11')
  assert.deepEqual(m.kanbanFlow.byStage, { draft: 1, specified: 1, clarified: 0, planned: 0, tasked: 0, implementing: 2, review: 1, done: 2 })
  assert.deepEqual([m.kanbanFlow.total, m.kanbanFlow.wip], [7, 4])
  assert.deepEqual(m.kanbanFlow.bottlenecks, { unresolvedClarifications: 1, blockedSpecs: 1 })
  assert.deepEqual(m.scrumCadence.activeMilestones.map((x) => [x.title, x.doneItems, x.totalItems, x.percentComplete, x.overdue]), [
    ['Late', 0, 2, 0, true],
    ['Empty', 0, 0, 0, false]
  ])
  assert.deepEqual(m.safeStrategic.epics.map((e) => [e.title, e.doneItems, e.totalItems, e.percentComplete]), [['Growth', 1, 3, 33]])
  assert.equal(m.safeStrategic.unassignedItemsCount, 4)
})

test('boardColumns: spec phases, work item statuses, or grouped Draft / In progress / Done', () => {
  const specs = [spec('001', 'draft'), spec('002', 'planned'), spec('003', 'done')]
  const items = [wi('WI-001', 'draft'), wi('WI-002', 'review'), wi('WI-003', 'in-progress')]
  const keys = (cols: ReturnType<typeof boardColumns>) => cols.map((c) => [c.id, [...c.specs, ...c.workItems].map((i) => i.key)])
  assert.equal(boardColumns('specs', specs, items).length, 7)
  assert.ok(boardColumns('specs', specs, items).every((c) => c.workItems.length === 0))
  assert.deepEqual(keys(boardColumns('workItems', specs, items)), [['draft', ['WI-001']], ['in-progress', ['WI-003']], ['review', ['WI-002']], ['done', []]])
  assert.deepEqual(keys(boardColumns('all', specs, items)), [['draft', ['001', 'WI-001']], ['in-progress', ['002', 'WI-002', 'WI-003']], ['done', ['003']]])
})
