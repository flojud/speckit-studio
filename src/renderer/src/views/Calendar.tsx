import { useState } from 'react'
import type { ProjectSnapshot } from '../../../shared/types'
import { dayKey, monthGrid, type CalendarEntry } from '../../../shared/pm'
import { Dot } from './Board'

interface Props {
  projectId: number
  snap: ProjectSnapshot
  onOpen: (key: string) => void
}

const weekStart: number =
  (new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number } }).getWeekInfo?.().firstDay ?? 1
// 2026-01-05 is a Monday; rotate from there by the locale's first day.
const weekdays = Array.from({ length: 7 }, (_, i) =>
  new Date(2026, 0, 5 + ((weekStart - 1 + i) % 7)).toLocaleDateString(undefined, { weekday: 'short' })
)

/** Month grid of milestones by due date. Drag a milestone to another day or to Unscheduled to reschedule it. */
export function Calendar({ projectId, snap, onOpen }: Props): React.JSX.Element {
  const milestones = snap.milestones ?? []
  const now = new Date()
  const [shown, setShown] = useState({ y: now.getFullYear(), m: now.getMonth() })
  const [expanded, setExpanded] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const grid = monthGrid(shown.y, shown.m, weekStart, dayKey(now), snap.specs, milestones, snap.workItems)
  const shift = (n: number): void => {
    const d = new Date(shown.y, shown.m + n, 1)
    setShown({ y: d.getFullYear(), m: d.getMonth() })
  }

  // Drop target for a day (`due` = its date) or Unscheduled (`due` = null).
  const target = (key: string, due: string | null): React.HTMLAttributes<HTMLElement> => ({
    onDragOver: (e) => {
      e.preventDefault()
      setOver(key)
    },
    onDragLeave: () => setOver((o) => (o === key ? null : o)),
    onDrop: (e) => {
      e.preventDefault()
      setOver(null)
      const m = milestones.find((x) => x.id === Number(e.dataTransfer.getData('text/plain')))
      if (m && m.due !== due) window.api.pm.setMilestoneDue(projectId, m.id, due)
    }
  })
  const nav = 'rounded-md border border-line px-2.5 text-dim hover:text-fg'

  return (
    <div className="space-y-3">
      <div
        tabIndex={0}
        aria-label="Calendar month, use arrow keys to change"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') shift(-1)
          if (e.key === 'ArrowRight') shift(1)
        }}
        className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-accent w-fit"
      >
        <button className={nav} aria-label="Previous month" onClick={() => shift(-1)}>‹</button>
        <span className="w-40 text-center font-medium">
          {new Date(shown.y, shown.m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </span>
        <button className={nav} aria-label="Next month" onClick={() => shift(1)}>›</button>
        <button className={nav} onClick={() => setShown({ y: now.getFullYear(), m: now.getMonth() })}>Today</button>
      </div>

      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0">
          <div className="grid grid-cols-7 gap-1 text-[11px] text-dim mb-1">
            {weekdays.map((w) => <div key={w} className="px-1.5">{w}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {grid.weeks.flat().map((d) => {
              const all = d.milestones
              const shownHere = expanded === d.date ? all : all.slice(0, 3)
              return (
                <div
                  key={d.date}
                  {...target(d.date, d.date)}
                  className={`min-h-28 min-w-0 rounded-lg border p-1.5 space-y-1 ${d.today ? 'border-accent' : 'border-line'} ${d.inMonth ? '' : 'opacity-50'} ${over === d.date ? 'bg-raised' : ''}`}
                >
                  <div className={`text-[11px] ${d.today ? 'text-accent font-medium' : 'text-dim'}`}>{Number(d.date.slice(8))}</div>
                  {shownHere.map((e) => <Card key={e.milestone.id} entry={e} onOpen={onOpen} />)}
                  {all.length > shownHere.length && (
                    <button className="text-[11px] text-dim hover:text-fg" onClick={() => setExpanded(d.date)}>
                      +{all.length - shownHere.length} more
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {!milestones.some((m) => m.due) && <p className="text-dim mt-3">Add milestones with a due date in the grid view.</p>}
        </div>

        <div
          {...target('unscheduled', null)}
          className={`w-60 shrink-0 rounded-lg border border-dashed border-line p-2 space-y-1.5 ${over === 'unscheduled' ? 'bg-raised' : ''}`}
        >
          <div className="text-dim text-[11px] font-medium">Unscheduled</div>
          {grid.unscheduled.map((e) => <Card key={e.milestone.id} entry={e} onOpen={onOpen} />)}
        </div>
      </div>
    </div>
  )
}

function Card({ entry: { milestone: m, specs, status }, onOpen }: { entry: CalendarEntry; onOpen: (key: string) => void }): React.JSX.Element {
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', String(m.id))}
      className={`rounded-md bg-panel border p-1.5 space-y-1 cursor-grab ${status.overdue ? 'border-[#eb5757]' : 'border-line'}`}
    >
      <div className="flex items-center gap-1.5 text-[12px] font-medium">
        <span className="truncate">{m.title}</span>
        {status.overdue && <span title="Overdue" aria-label="Overdue" className="text-[#eb5757]">⚠</span>}
        <span className="ml-auto shrink-0 text-dim text-[11px] font-normal">{status.total ? `${status.done}/${status.total}` : '0 specs'}</span>
      </div>
      {specs.map((s) => (
        <button key={s.key} onClick={() => onOpen(s.key)} className="w-full flex items-center gap-1.5 rounded border border-line px-1.5 py-1 text-left text-[12px] hover:bg-raised">
          <Dot phase={s.phase} />
          <span className="text-dim text-[11px]">{s.number}</span>
          <span className="truncate">{s.title}</span>
          {s.blocked && <span title={`Blocked by ${s.blockedBy?.join(', ')}`}>🔒</span>}
        </button>
      ))}
    </div>
  )
}
