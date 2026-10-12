import { useState } from 'react'
import type { ProjectSnapshot } from '../../../shared/types'
import { epicProgress, roadmapGrid } from '../../../shared/pm'
import { Dot } from './Board'
import { Calendar } from './Calendar'

interface Props {
  projectId: number
  snap: ProjectSnapshot
  onOpen: (key: string) => void
}

/** Milestones × epics grid. Specs land in the cell of their epic and milestone. */
export function Roadmap({ projectId, snap, onOpen }: Props): React.JSX.Element {
  const pm = window.api.pm
  const epics = snap.epics ?? []
  const milestones = snap.milestones ?? []
  const grid = roadmapGrid(snap.specs, epics, milestones)
  const [epic, setEpic] = useState('')
  const [milestone, setMilestone] = useState('')
  const [due, setDue] = useState('')
  const [view, setView] = useState(() => localStorage.getItem(`roadmapView:${projectId}`) ?? 'grid')
  const input = 'bg-raised border border-line rounded px-2 py-1 outline-none focus:border-accent select-text'

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap gap-6">
        <div className="flex rounded-md border border-line overflow-hidden">
          {['grid', 'calendar'].map((v) => (
            <button
              key={v}
              aria-pressed={view === v}
              onClick={() => (setView(v), localStorage.setItem(`roadmapView:${projectId}`, v))}
              className={`px-2.5 capitalize ${view === v ? 'bg-raised text-fg' : 'text-dim hover:text-fg'}`}
            >
              {v}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (epic.trim()) pm.createEpic(projectId, epic.trim()).then(() => setEpic(''))
          }}
        >
          <input className={input} placeholder="New epic…" value={epic} onChange={(e) => setEpic(e.target.value)} />
          <button className="rounded-md border border-line px-2.5 text-dim hover:text-fg">Add epic</button>
        </form>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (milestone.trim()) pm.createMilestone(projectId, milestone.trim(), due || null).then(() => (setMilestone(''), setDue('')))
          }}
        >
          <input className={input} placeholder="New milestone…" value={milestone} onChange={(e) => setMilestone(e.target.value)} />
          <input className={input} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          <button className="rounded-md border border-line px-2.5 text-dim hover:text-fg">Add milestone</button>
        </form>
      </div>

      {view === 'calendar' ? (
        <Calendar projectId={projectId} snap={snap} onOpen={onOpen} />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="border-separate border-spacing-2 -m-2">
              <thead>
                <tr>
                  <th className="w-56" />
                  {grid.columns.map((m) => (
                    <th key={m?.id ?? 'none'} className="min-w-56 text-left font-medium align-bottom">
                      <div className="flex items-center gap-2">
                        {m ? m.title : <span className="text-dim">Unscheduled</span>}
                        {m?.due && <span className="text-dim text-[11px] font-normal">{m.due}</span>}
                        {m && <DeleteBtn label={`Delete milestone ${m.title}`} onClick={() => pm.deleteMilestone(projectId, m.id)} />}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map(({ epic: e, cells }) => {
                  const p = epicProgress(cells.flat())
                  return (
                    <tr key={e?.id ?? 'none'}>
                      <td className="align-top rounded-lg bg-panel border border-line p-3 space-y-2">
                        <div className="flex items-center gap-2 font-medium">
                          {e ? e.title : <span className="text-dim">No epic</span>}
                          {e && <DeleteBtn label={`Delete epic ${e.title}`} onClick={() => pm.deleteEpic(projectId, e.id)} />}
                        </div>
                        <div className="text-[11px] text-dim">
                          {p.specsDone}/{p.specs} specs done{p.tasks ? ` · ${p.tasksDone}/${p.tasks} tasks` : ''}
                        </div>
                        <div className="h-1 rounded bg-raised overflow-hidden">
                          <div className="h-full bg-[#4cb782]" style={{ width: `${p.tasks ? (p.tasksDone / p.tasks) * 100 : p.specs ? (p.specsDone / p.specs) * 100 : 0}%` }} />
                        </div>
                      </td>
                      {cells.map((specs, i) => (
                        <td key={i} className="align-top rounded-lg border border-dashed border-line p-2 space-y-1.5">
                          {specs.map((s) => (
                            <button key={s.key} onClick={() => onOpen(s.key)} className="w-full flex items-center gap-2 rounded-md bg-panel border border-line px-2 py-1.5 text-left hover:bg-raised">
                              <Dot phase={s.phase} />
                              <span className="text-dim text-[11px]">{s.number}</span>
                              <span className="truncate">{s.title}</span>
                              {s.blocked && <span title={`Blocked by ${s.blockedBy?.join(', ')}`}>🔒</span>}
                            </button>
                          ))}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {epics.length === 0 && milestones.length === 0 && (
            <p className="text-dim">Add epics and milestones, then assign specs to them from the spec header.</p>
          )}
        </>
      )}
    </div>
  )
}

const DeleteBtn = ({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element => (
  <button aria-label={label} title={label} onClick={onClick} className="text-dim hover:text-[#eb5757] font-normal">
    ×
  </button>
)
