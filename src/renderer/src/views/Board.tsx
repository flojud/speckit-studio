import { useEffect, useRef, useState } from 'react'
import { boardColumns, type BoardMode } from '../../../shared/pm'
import { PHASES, type Phase, type ProjectSnapshot, type Spec, type WorkItem, type WorkItemCategory, type WorkItemStatus } from '../../../shared/types'

export const PHASE_LABEL: Record<Phase, string> = {
  draft: 'Draft',
  specified: 'Specified',
  clarified: 'Clarified',
  planned: 'Planned',
  tasked: 'Tasked',
  implementing: 'Implementing',
  done: 'Done'
}

export const PHASE_COLOR: Record<Phase, string> = {
  draft: '#6b6c72',
  specified: '#8a8b91',
  clarified: '#4ea7fc',
  planned: '#7c6cf2',
  tasked: '#d38cf0',
  implementing: '#f2c94c',
  done: '#4cb782'
}

export const WI_STATUS_LABEL: Record<WorkItemStatus, string> = { draft: 'Draft', 'in-progress': 'In progress', review: 'Review', done: 'Done' }
export const WI_STATUS_COLOR: Record<WorkItemStatus, string> = { draft: '#6b6c72', 'in-progress': '#f2c94c', review: '#e07fb0', done: '#4cb782' }
export const CATEGORY_LABEL: Record<WorkItemCategory, string> = {
  'business-plan': 'Business plan',
  marketing: 'Marketing',
  'wiki-doc': 'Wiki doc',
  research: 'Research',
  operations: 'Operations',
  general: 'General'
}
export const CATEGORY_COLOR: Record<WorkItemCategory, string> = {
  'business-plan': '#4ea7fc',
  marketing: '#f2994a',
  'wiki-doc': '#7c6cf2',
  research: '#26b5ce',
  operations: '#8a8b91',
  general: '#6b6c72'
}

const MODES: [BoardMode, string][] = [
  ['specs', 'Specs'],
  ['workItems', 'Work items'],
  ['all', 'All']
]

/** Command that produces a phase – dropping a card on that column runs it. Done merges the spec branch instead. */
const DROP_COMMAND: Partial<Record<Phase, string>> = { specified: 'specify', clarified: 'clarify', planned: 'plan', tasked: 'tasks', implementing: 'implement', done: 'merge' }

interface BoardProps {
  snap: ProjectSnapshot
  epicFilter: number | 'all'
  onEpicFilter: (f: number | 'all') => void
  onOpen: (key: string) => void
  onOpenWorkItem: (key: string) => void
  onNewSpec: () => void
  onNewWorkItem: () => void
  onRun: (specKey: string, command: string) => void
  onMerge: (specKey: string) => void
}

export function Board(props: BoardProps): React.JSX.Element {
  const { snap, epicFilter, onOpen } = props
  const inEpic = <T extends { epicId?: number | null }>(items: T[]): T[] => (epicFilter === 'all' ? items : items.filter((i) => i.epicId === epicFilter))
  const specs = inEpic(snap.specs)
  const [mode, setMode] = useState<BoardMode>(() => (localStorage.getItem('boardMode') as BoardMode | null) ?? 'specs')
  useEffect(() => localStorage.setItem('boardMode', mode), [mode])
  const [over, setOver] = useState<Phase>()
  const drop = (phase: Phase, key: string): void => {
    setOver(undefined)
    const spec = specs.find((s) => s.key === key)
    const command = DROP_COMMAND[phase]
    if (spec && command && PHASES.indexOf(phase) > PHASES.indexOf(spec.phase)) (command === 'merge' ? props.onMerge(key) : props.onRun(key, command))
  }
  // Dropping runs Spec Kit commands, so only on the spec phase columns.
  const dropCommand = (id: string): string | undefined => (mode === 'specs' ? DROP_COMMAND[id as Phase] : undefined)
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 pt-3">
        <button onClick={props.onNewSpec} className="rounded-md bg-accent text-white px-2.5 py-1 hover:opacity-90" title="New spec (C)">
          + New spec
        </button>
        <button onClick={props.onNewWorkItem} className="rounded-md border border-line px-2.5 py-1 hover:bg-raised" title="New work item (W)">
          + New work item
        </button>
        <div className="flex rounded-md border border-line overflow-hidden" role="group" aria-label="Board mode">
          {MODES.map(([m, label]) => (
            <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m} className={`px-2.5 py-1 ${mode === m ? 'bg-raised text-fg' : 'text-dim hover:text-fg'}`}>
              {label}
            </button>
          ))}
        </div>
        {!!snap.epics?.length && (
          <select
            value={epicFilter}
            onChange={(e) => props.onEpicFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            className="bg-raised border border-line rounded px-1.5 py-1 outline-none"
          >
            <option value="all">All epics</option>
            {snap.epics.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
        )}
      </div>
    <div className="flex flex-1 min-h-0 gap-3 p-4 overflow-x-auto">
      {boardColumns(mode, specs, inEpic(snap.workItems)).map(({ id, specs: items, workItems }) => {
        const phase = id as Phase
        return (
          <section
            key={id}
            className={`flex-1 min-w-36 flex flex-col rounded-lg ${over === id ? 'bg-raised/60 outline outline-1 outline-accent' : ''}`}
            onDragOver={(e) => dropCommand(id) && (e.preventDefault(), setOver(phase))}
            onDragLeave={() => setOver(undefined)}
            onDrop={(e) => dropCommand(id) && drop(phase, e.dataTransfer.getData('text/spec'))}
          >
            <h2 className="flex items-center gap-2 px-1 pb-2 text-dim">
              <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: mode === 'specs' ? PHASE_COLOR[phase] : WI_STATUS_COLOR[id as WorkItemStatus] }} />
              <span className="text-fg font-medium">{mode === 'specs' ? PHASE_LABEL[phase] : WI_STATUS_LABEL[id as WorkItemStatus]}</span>
              <span>{items.length + workItems.length}</span>
            </h2>
            <div className="space-y-2 overflow-y-auto">
              {items.map((s) => (
                <Card key={s.key} spec={s} onClick={() => onOpen(s.key)} onRun={props.onRun} />
              ))}
              {workItems.map((w) => (
                <WorkItemCard key={w.key} item={w} onClick={() => props.onOpenWorkItem(w.key)} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
    </div>
  )
}

interface NewSpecProps {
  onCancel: () => void
  /** Starts specify right away (no draft). */
  onSubmit: (text: string) => void
  onSaveDraft: (title: string, description: string) => Promise<void>
}

export function NewSpecDialog({ onCancel, onSubmit, onSaveDraft }: NewSpecProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [again, setAgain] = useState(false)
  const [error, setError] = useState<string>()
  const titleRef = useRef<HTMLInputElement>(null)
  const submit = (): void => void (text.trim() && onSubmit(title.trim() ? `${title.trim()}\n\n${text.trim()}` : text.trim()))
  const save = (): void => {
    if (!title.trim()) return
    setError(undefined)
    onSaveDraft(title, text)
      .then(() => (again ? (setTitle(''), setText(''), titleRef.current?.focus()) : onCancel()))
      .catch((e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
  }
  const onKey = (e: React.KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'Enter') submit()
    else if (mod && e.key === 's') (e.preventDefault(), save())
    else if (e.key === 'Escape') onCancel()
  }
  const field = 'w-full rounded-md bg-raised border border-line px-3 py-2 outline-none focus:border-accent select-text'
  return (
    <div className="fixed inset-0 z-10 grid place-items-center bg-black/50" onClick={onCancel}>
      <div className="w-[560px] rounded-xl border border-line bg-panel p-4 space-y-3" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <h2 className="font-semibold">New spec</h2>
        <p className="text-dim">
          Describe what you want to build and why – not the tech stack. Save it as a draft for later, or let the agent run <code>specify</code> with it now.
        </p>
        <input ref={titleRef} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className={field} placeholder="Title, e.g. Album sharing" />
        <textarea
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={`${field} resize-none`}
          placeholder="Users can organize photos into albums by dragging them…"
        />
        {error && <p className="text-[#eb5757] select-text">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <label className="mr-auto flex items-center gap-1.5 text-dim">
            <input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} /> Create another
          </label>
          <button onClick={onCancel} className="rounded-md px-2.5 py-1 text-dim hover:text-fg">Cancel</button>
          <button onClick={save} disabled={!title.trim()} className="rounded-md border border-line px-2.5 py-1 hover:bg-raised disabled:opacity-40">
            Save as draft ⌘S
          </button>
          <button onClick={submit} disabled={!text.trim()} className="rounded-md bg-accent text-white px-2.5 py-1 disabled:opacity-40">
            Start specify ⌘↵
          </button>
        </div>
      </div>
    </div>
  )
}

function Card({ spec, onClick, onRun }: { spec: Spec; onClick: () => void; onRun: (key: string, command: string) => void }): React.JSX.Element {
  const done = spec.tasks.filter((t) => t.done).length
  const stale = spec.artifacts.some((a) => a.stale)
  return (
    <button
      onClick={onClick}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/spec', spec.key)}
      className="w-full text-left rounded-lg border border-line bg-panel hover:bg-raised p-3 space-y-2">
      <div className="flex items-center text-dim text-[11px]">
        {spec.number || spec.key}
        {spec.phase === 'draft' && spec.description !== undefined && (
          <span
            role="button"
            onClick={(e) => (e.stopPropagation(), onRun(spec.key, 'specify'))}
            className="ml-auto rounded px-1.5 hover:bg-raised hover:text-fg"
            title={spec.description.trim() ? 'Run specify with the draft description' : 'Add a description to the draft first'}
          >
            Specify
          </span>
        )}
      </div>
      <div className="font-medium leading-snug">{spec.title}</div>
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {spec.openClarifications > 0 && <Badge color="#f2994a">{spec.openClarifications} open question{spec.openClarifications > 1 ? 's' : ''}</Badge>}
        {stale && <Badge color="#eb5757">stale</Badge>}
        <AnalysisBadge spec={spec} />
        {spec.blocked && <Badge color="#f2994a">🔒 blocked</Badge>}
        <GitBadge spec={spec} />
      </div>
      {spec.tasks.length > 0 && (
        <div className="flex items-center gap-2 text-[11px] text-dim">
          <div className="h-1 flex-1 rounded bg-raised overflow-hidden">
            <div className="h-full bg-[#4cb782]" style={{ width: `${(done / spec.tasks.length) * 100}%` }} />
          </div>
          {done}/{spec.tasks.length}
        </div>
      )}
    </button>
  )
}

function WorkItemCard({ item, onClick }: { item: WorkItem; onClick: () => void }): React.JSX.Element {
  return (
    <button onClick={onClick} className="w-full text-left rounded-lg border border-line bg-panel hover:bg-raised p-3 space-y-2">
      <div className="text-dim text-[11px]">{item.key.match(/^WI-\d+/i)?.[0] ?? item.key}</div>
      <div className="font-medium leading-snug">{item.title}</div>
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <CategoryBadge category={item.category} />
        {item.status === 'review' && <Badge color={WI_STATUS_COLOR.review}>review</Badge>}
      </div>
    </button>
  )
}

export const CategoryBadge = ({ category }: { category: WorkItemCategory }): React.JSX.Element => (
  <Badge color={CATEGORY_COLOR[category]}>{CATEGORY_LABEL[category]}</Badge>
)

export const Dot = ({ phase }: { phase: Phase }): React.JSX.Element => (
  <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: PHASE_COLOR[phase] }} />
)

export const Badge = ({ color, children }: { color: string; children: React.ReactNode }): React.JSX.Element => (
  <span className="rounded px-1.5 py-0.5" style={{ color, background: `${color}22` }}>
    {children}
  </span>
)

export function AnalysisBadge({ spec }: { spec: Spec }): React.JSX.Element | null {
  if (!spec.analysis) return null
  return spec.analysis.critical ? (
    <Badge color="#eb5757">{spec.analysis.critical} critical</Badge>
  ) : (
    <Badge color="#4cb782">analysis ok</Badge>
  )
}

export function GitBadge({ spec }: { spec: Spec }): React.JSX.Element | null {
  if (!spec.git) return null
  return (
    <>
      {spec.git.worktree && <Badge color="#d38cf0">worktree</Badge>}
      {spec.git.state === 'branch' && <Badge color="#8a8b91">⎇ unmerged</Badge>}
      {spec.git.state === 'merged' && <Badge color="#4cb782">⎇ in main</Badge>}
    </>
  )
}
