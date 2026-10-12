import { computeDashboardMetrics, dayKey } from '../../../shared/pm'
import { PHASES, type ProjectSnapshot, type Run } from '../../../shared/types'
import { PHASE_COLOR, PHASE_LABEL, WI_STATUS_COLOR } from './Board'
import { RunList, useRuns } from './SpecDetail'

interface Props {
  projectId: number
  snap: ProjectSnapshot
  rev: number
  onNewSpec: () => void
  onNewWorkItem: () => void
  onOpenBoard: () => void
  onOpenRoadmap: () => void
  onOpenRuns: () => void
  onOpenRun: (r: Run) => void
}

const STAGES = [...PHASES.slice(0, -1), 'review', 'done'] as const
const STAGE_LABEL = { ...PHASE_LABEL, implementing: 'Implementing / In progress', review: 'Review' }
const STAGE_COLOR = { ...PHASE_COLOR, review: WI_STATUS_COLOR.review }

/** Project landing: Kanban flow, Scrum milestones, SAFe epics, recent agent runs – all derived from the snapshot. */
export function Dashboard(props: Props): React.JSX.Element {
  const { snap } = props
  const m = computeDashboardMetrics(snap.specs, snap.workItems, snap.epics ?? [], snap.milestones ?? [], dayKey(new Date()))
  const runs = useRuns(props.projectId, undefined, props.rev).slice(0, 5)
  const flow = m.kanbanFlow
  const noPm = !snap.epics?.length && !snap.milestones?.length

  return (
    <div className="px-6 py-5 space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={props.onNewSpec} className="rounded-md bg-accent text-white px-2.5 py-1 hover:opacity-90" title="New spec (C)">
          + New spec
        </button>
        <button onClick={props.onNewWorkItem} className="rounded-md border border-line px-2.5 py-1 hover:bg-raised" title="New work item (W)">
          + New work item
        </button>
        <button onClick={props.onOpenBoard} className="rounded-md px-2.5 py-1 text-dim hover:text-fg">
          Open board →
        </button>
      </div>

      {flow.total === 0 ? (
        <Card title="Welcome">
          <p className="text-dim">Nothing here yet. Create your first spec for code work, or a work item for business plans, marketing, research or docs.</p>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="Kanban flow" action={<span className="text-dim text-[11px]">{flow.total} items · {flow.wip} in progress</span>}>
            <div className="flex h-2 rounded overflow-hidden bg-raised">
              {STAGES.map((s) => flow.byStage[s] > 0 && <div key={s} title={`${STAGE_LABEL[s]}: ${flow.byStage[s]}`} style={{ width: `${(flow.byStage[s] / flow.total) * 100}%`, background: STAGE_COLOR[s] }} />)}
            </div>
            <ul className="grid grid-cols-2 gap-x-6 gap-y-1">
              {STAGES.map((s) => (
                <li key={s} className="flex items-center gap-2">
                  <span className="size-2 rounded-full shrink-0" style={{ background: STAGE_COLOR[s] }} />
                  <span className="flex-1 text-dim">{STAGE_LABEL[s]}</span>
                  <span>{flow.byStage[s]}</span>
                </li>
              ))}
            </ul>
            {(flow.bottlenecks.unresolvedClarifications > 0 || flow.bottlenecks.blockedSpecs > 0) && (
              <p className="text-[#f2994a] text-[12px]">
                Bottlenecks: {flow.bottlenecks.unresolvedClarifications} awaiting clarification · {flow.bottlenecks.blockedSpecs} blocked
              </p>
            )}
          </Card>

          <Card title="Recent agent activity" action={<Link onClick={props.onOpenRuns}>All runs</Link>}>
            {runs.length ? <RunList runs={runs} onOpen={props.onOpenRun} /> : <p className="text-dim">No runs yet.</p>}
          </Card>

          {noPm ? (
            <Card title="Milestones & epics" action={<Link onClick={props.onOpenRoadmap}>Roadmap</Link>}>
              <p className="text-dim">Tip: add milestones (sprints) and epics in the Roadmap, then assign specs and work items to see cadence and portfolio progress here.</p>
            </Card>
          ) : (
            <>
              <Card title="Milestones" action={<Link onClick={props.onOpenRoadmap}>Roadmap</Link>}>
                {m.scrumCadence.activeMilestones.length ? (
                  m.scrumCadence.activeMilestones.map((ms) => (
                    <Progress key={ms.id} label={ms.title} sub={ms.due ?? 'no due date'} done={ms.doneItems} total={ms.totalItems} pct={ms.percentComplete} warn={ms.overdue ? 'overdue' : undefined} />
                  ))
                ) : (
                  <p className="text-dim">All milestones complete.</p>
                )}
              </Card>
              <Card title="Epics" action={<span className="text-dim text-[11px]">{m.safeStrategic.unassignedItemsCount} items without epic</span>}>
                {m.safeStrategic.epics.length ? (
                  m.safeStrategic.epics.map((e) => <Progress key={e.id} label={e.title} sub={e.goal} done={e.doneItems} total={e.totalItems} pct={e.percentComplete} />)
                ) : (
                  <p className="text-dim">No epics yet.</p>
                )}
              </Card>
            </>
          )}
        </div>
      )}
    </div>
  )
}

const Card = ({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }): React.JSX.Element => (
  <section className="rounded-lg border border-line bg-panel p-4 space-y-3">
    <h2 className="flex items-center gap-2 font-medium">
      {title}
      <span className="ml-auto font-normal">{action}</span>
    </h2>
    {children}
  </section>
)

const Link = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }): React.JSX.Element => (
  <button onClick={onClick} className="text-dim text-[11px] hover:text-fg">
    {children} →
  </button>
)

function Progress(p: { label: string; sub: string; done: number; total: number; pct: number; warn?: string }): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="truncate">{p.label}</span>
        {p.warn && <span className="rounded px-1.5 text-[11px] text-[#eb5757] bg-[#eb575722]">{p.warn}</span>}
        <span className="ml-auto text-dim text-[11px] truncate">{p.sub}</span>
        <span className="text-dim text-[11px] w-20 text-right">
          {p.done}/{p.total} · {p.pct}%
        </span>
      </div>
      <div className="h-1 rounded bg-raised overflow-hidden">
        <div className="h-full bg-[#4cb782]" style={{ width: `${p.pct}%` }} />
      </div>
    </div>
  )
}
