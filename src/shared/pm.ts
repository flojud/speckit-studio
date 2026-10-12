import { PHASES, WORK_ITEM_STATUSES, type DashboardMetrics, type Epic, type Milestone, type Phase, type PmData, type Spec, type WorkItem, type WorkItemStatus } from './types.ts'

/** Joins PM data from the app DB onto file-derived specs and work items (mutates). Missing blockers never lock. */
export function applyPm(specs: Spec[], pm: PmData, workItems: WorkItem[] = []): void {
  const wiMeta = new Map(pm.workItemMeta?.map((m) => [m.workItemKey, m]))
  for (const w of workItems) {
    w.epicId = wiMeta.get(w.key)?.epicId ?? null
    w.milestoneId = wiMeta.get(w.key)?.milestoneId ?? null
  }
  const byKey = new Map(specs.map((s) => [s.key, s]))
  const meta = new Map(pm.meta.map((m) => [m.specKey, m]))
  for (const s of specs) {
    s.epicId = meta.get(s.key)?.epicId ?? null
    s.milestoneId = meta.get(s.key)?.milestoneId ?? null
    s.blockedBy = pm.deps.filter((d) => d.specKey === s.key).map((d) => d.blockedBy)
    s.blocked = s.blockedBy.some((k) => byKey.has(k) && byKey.get(k)!.phase !== 'done')
  }
}

export interface RoadmapGrid {
  /** Milestones in order, then null = Unscheduled. */
  columns: (Milestone | null)[]
  /** Epics in order, then null = No epic (only if it has specs). */
  rows: { epic: Epic | null; cells: Spec[][] }[]
}

export function roadmapGrid(specs: Spec[], epics: Epic[], milestones: Milestone[]): RoadmapGrid {
  const columns = [...milestones, null]
  const row = (epic: Epic | null): RoadmapGrid['rows'][number] => ({
    epic,
    cells: columns.map((m) => specs.filter((s) => (s.epicId ?? null) === (epic?.id ?? null) && (s.milestoneId ?? null) === (m?.id ?? null)))
  })
  const rows = [...epics, null].map(row)
  if (rows.at(-1)!.cells.every((c) => c.length === 0)) rows.pop()
  return { columns, rows }
}

export interface MilestoneStatus { done: number; total: number; overdue: boolean }
export interface CalendarEntry { milestone: Milestone; specs: Spec[]; status: MilestoneStatus }
export interface CalendarDay { date: string; inMonth: boolean; today: boolean; milestones: CalendarEntry[] }
export interface MonthGrid { weeks: CalendarDay[][]; unscheduled: CalendarEntry[] }

/** Local YYYY-MM-DD. Never parse these back with `new Date('YYYY-MM-DD')` – that is UTC. */
export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Every spec and work item weighs the same; only `done` counts as complete. */
const doneCount = (specs: Spec[], workItems: WorkItem[]): number =>
  specs.filter((s) => s.phase === 'done').length + workItems.filter((w) => w.status === 'done').length

export function milestoneStatus(specs: Spec[], due: string | null, today: string, workItems: WorkItem[] = []): MilestoneStatus {
  const done = doneCount(specs, workItems)
  const total = specs.length + workItems.length
  return { done, total, overdue: due !== null && due < today && done < total }
}

/** Always 6 weeks; weekStart 1 = Monday … 7 = Sunday; month 0-11. */
export function monthGrid(year: number, month: number, weekStart: number, today: string, specs: Spec[], milestones: Milestone[], workItems: WorkItem[] = []): MonthGrid {
  const entry = (m: Milestone): CalendarEntry => {
    const own = specs.filter((s) => s.milestoneId === m.id)
    return { milestone: m, specs: own, status: milestoneStatus(own, m.due, today, workItems.filter((w) => w.milestoneId === m.id)) }
  }
  const offset = (new Date(year, month, 1).getDay() - (weekStart % 7) + 7) % 7
  const days = Array.from({ length: 42 }, (_, i): CalendarDay => {
    const d = new Date(year, month, 1 - offset + i)
    const date = dayKey(d)
    return { date, inMonth: d.getMonth() === month, today: date === today, milestones: milestones.filter((m) => m.due === date).map(entry) }
  })
  return {
    weeks: Array.from({ length: 6 }, (_, w) => days.slice(w * 7, w * 7 + 7)),
    unscheduled: milestones.filter((m) => m.due === null).map(entry)
  }
}

export function epicProgress(
  specs: Spec[],
  workItems: WorkItem[] = []
): { tasksDone: number; tasks: number; specsDone: number; specs: number; done: number; total: number } {
  return {
    tasksDone: specs.reduce((n, s) => n + s.tasks.filter((t) => t.done).length, 0),
    tasks: specs.reduce((n, s) => n + s.tasks.length, 0),
    specsDone: specs.filter((s) => s.phase === 'done').length,
    specs: specs.length,
    done: doneCount(specs, workItems),
    total: specs.length + workItems.length
  }
}

const pct = (done: number, total: number): number => (total ? Math.round((done / total) * 100) : 0)

/** Work item status → Kanban flow stage of the dashboard. */
const WI_STAGE: Record<WorkItemStatus, Phase | 'review'> = { draft: 'draft', 'in-progress': 'implementing', review: 'review', done: 'done' }

/** All dashboard numbers, derived from the snapshot on every render (nothing stored). */
export function computeDashboardMetrics(specs: Spec[], workItems: WorkItem[], epics: Epic[], milestones: Milestone[], today: string): DashboardMetrics {
  const byStage = { draft: 0, specified: 0, clarified: 0, planned: 0, tasked: 0, implementing: 0, review: 0, done: 0 }
  specs.forEach((s) => byStage[s.phase]++)
  workItems.forEach((w) => byStage[WI_STAGE[w.status]]++)
  const total = specs.length + workItems.length
  const own = <T extends { epicId?: number | null; milestoneId?: number | null }>(items: T[], field: 'epicId' | 'milestoneId', id: number): T[] =>
    items.filter((i) => i[field] === id)
  return {
    kanbanFlow: {
      total,
      wip: total - byStage.draft - byStage.done,
      byStage,
      bottlenecks: { unresolvedClarifications: specs.filter((s) => s.openClarifications > 0).length, blockedSpecs: specs.filter((s) => s.blocked).length }
    },
    scrumCadence: {
      activeMilestones: milestones
        .map((m) => {
          const st = milestoneStatus(own(specs, 'milestoneId', m.id), m.due, today, own(workItems, 'milestoneId', m.id))
          return { id: m.id, title: m.title, due: m.due, totalItems: st.total, doneItems: st.done, percentComplete: pct(st.done, st.total), overdue: st.overdue }
        })
        .filter((m) => m.totalItems === 0 || m.doneItems < m.totalItems)
    },
    safeStrategic: {
      epics: epics.map((e) => {
        const p = epicProgress(own(specs, 'epicId', e.id), own(workItems, 'epicId', e.id))
        return { id: e.id, title: e.title, goal: e.goal, totalItems: p.total, doneItems: p.done, percentComplete: pct(p.done, p.total) }
      }),
      unassignedItemsCount: [...specs, ...workItems].filter((i) => i.epicId == null).length
    }
  }
}

export type BoardMode = 'specs' | 'workItems' | 'all'
export interface BoardColumn {
  /** A phase (specs mode) or a work item status (other modes) */
  id: Phase | WorkItemStatus
  specs: Spec[]
  workItems: WorkItem[]
}

/** Columns per board mode: spec phases, work item statuses, or both grouped into Draft / In progress / Done. */
export function boardColumns(mode: BoardMode, specs: Spec[], workItems: WorkItem[]): BoardColumn[] {
  if (mode === 'specs') return PHASES.map((id) => ({ id, specs: specs.filter((s) => s.phase === id), workItems: [] }))
  if (mode === 'workItems') return WORK_ITEM_STATUSES.map((id) => ({ id, specs: [], workItems: workItems.filter((w) => w.status === id) }))
  const macro = (s: Phase | WorkItemStatus): WorkItemStatus => (s === 'draft' || s === 'done' ? s : 'in-progress')
  return (['draft', 'in-progress', 'done'] as const).map((id) => ({
    id,
    specs: specs.filter((s) => macro(s.phase) === id),
    workItems: workItems.filter((w) => macro(w.status) === id)
  }))
}
