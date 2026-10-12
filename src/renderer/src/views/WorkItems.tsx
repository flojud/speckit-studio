import { useEffect, useState } from 'react'
import { WORK_ITEM_CATEGORIES, WORK_ITEM_STATUSES, type ProjectSnapshot, type Run, type WorkItem, type WorkItemCategory, type WorkItemStatus } from '../../../shared/types'
import { Markdown } from '../components/Markdown'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { CATEGORY_LABEL, CategoryBadge, WI_STATUS_COLOR, WI_STATUS_LABEL } from './Board'
import { RunList, useRuns } from './SpecDetail'

const select = 'bg-raised border border-line rounded px-1.5 py-0.5 outline-none text-fg'
const errorText = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** All work items with category/status filter and search. */
export function WorkItems({ snap, onOpen, onNew }: { snap: ProjectSnapshot; onOpen: (key: string) => void; onNew: () => void }): React.JSX.Element {
  const [category, setCategory] = useState<WorkItemCategory | ''>('')
  const [status, setStatus] = useState<WorkItemStatus | ''>('')
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const items = snap.workItems.filter(
    (w) => (!category || w.category === category) && (!status || w.status === status) && (!q || `${w.key} ${w.title} ${w.body}`.toLowerCase().includes(q))
  )
  return (
    <div className="px-6 py-5 space-y-4 max-w-4xl">
      <div className="flex items-center gap-2">
        <button onClick={onNew} className="rounded-md bg-accent text-white px-2.5 py-1 hover:opacity-90" title="New work item (W)">
          + New work item
        </button>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className="flex-1 bg-raised border border-line rounded px-2 py-1 outline-none focus:border-accent select-text" />
        <select className={select} value={category} onChange={(e) => setCategory(e.target.value as WorkItemCategory | '')} aria-label="Filter by category">
          <option value="">All categories</option>
          {WORK_ITEM_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
        <select className={select} value={status} onChange={(e) => setStatus(e.target.value as WorkItemStatus | '')} aria-label="Filter by status">
          <option value="">All statuses</option>
          {WORK_ITEM_STATUSES.map((s) => (
            <option key={s} value={s}>
              {WI_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      {items.length ? (
        <ul className="rounded-lg border border-line divide-y divide-line">
          {items.map((w) => (
            <li key={w.key}>
              <button onClick={() => onOpen(w.key)} className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-raised">
                <span className="size-2 rounded-full shrink-0" style={{ background: WI_STATUS_COLOR[w.status] }} title={WI_STATUS_LABEL[w.status]} />
                <span className="text-dim text-[11px] w-14 shrink-0">{w.key.match(/^WI-\d+/i)?.[0]}</span>
                <span className="truncate flex-1">{w.title}</span>
                <span className="text-[11px]">
                  <CategoryBadge category={w.category} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-dim">{snap.workItems.length ? 'No work items match the filter.' : 'No work items yet. Capture business plans, marketing, research or docs as Markdown in work-items/.'}</p>
      )}
    </div>
  )
}

interface DetailProps {
  projectId: number
  snap: ProjectSnapshot
  item: WorkItem
  rev: number
  onRunAgent: (prompt: string) => Promise<void>
  onOpenRun: (r: Run) => void
  onClose: () => void
}

/** One work item: metadata, PM links, Markdown body, agent runs. Every change is written to the file right away. */
export function WorkItemDetail({ projectId, snap, item, rev, onRunAgent, onOpenRun, onClose }: DetailProps): React.JSX.Element {
  const api = window.api.workItems
  const [title, setTitle] = useState(item.title)
  const [editing, setEditing] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string>()
  const runs = useRuns(projectId, item.key, rev)
  useEffect(() => setTitle(item.title), [item.title])

  const update = (u: Parameters<typeof api.update>[2]): Promise<void> => api.update(projectId, item.key, u).catch((e) => setError(errorText(e)))
  const saveTitle = (): void => void (title.trim() && title !== item.title ? update({ title }) : setTitle(item.title))
  async function remove(): Promise<void> {
    if (!window.confirm(`Delete ${item.file}? This removes the file from the repository.`)) return
    await api.remove(projectId, item.key).then(onClose, (e) => setError(errorText(e)))
  }
  const run = (): void => {
    if (!prompt.trim()) return
    setError(undefined)
    onRunAgent(prompt).then(() => setPrompt(''), (e) => setError(errorText(e)))
  }

  return (
    <div className="px-6 py-5 space-y-4 max-w-4xl h-full flex flex-col">
      <div className="flex items-center gap-2 text-dim text-[12px]">
        <span>{item.file}</span>
        <button onClick={remove} className="ml-auto hover:text-[#eb5757]">
          Delete
        </button>
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        aria-label="Title"
        className="w-full bg-transparent text-xl font-semibold outline-none border-b border-transparent focus:border-line select-text"
      />
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-dim">
        <label className="flex items-center gap-1">
          Status
          <select className={select} value={item.status} onChange={(e) => update({ status: e.target.value as WorkItemStatus })}>
            {WORK_ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {WI_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Category
          <select className={select} value={item.category} onChange={(e) => update({ category: e.target.value as WorkItemCategory })}>
            {WORK_ITEM_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Epic
          <select className={select} value={item.epicId ?? ''} onChange={(e) => window.api.pm.setWorkItemMeta(projectId, item.key, 'epic', e.target.value ? Number(e.target.value) : null)}>
            <option value="">–</option>
            {snap.epics?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Milestone
          <select className={select} value={item.milestoneId ?? ''} onChange={(e) => window.api.pm.setWorkItemMeta(projectId, item.key, 'milestone', e.target.value ? Number(e.target.value) : null)}>
            <option value="">–</option>
            {snap.milestones?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="text-[#eb5757] select-text">{error}</p>}

      <section className="space-y-2">
        <h3 className="font-medium">Run agent</h3>
        <div className="flex gap-2">
          <textarea
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && run()}
            placeholder="e.g. Draft a competitive analysis · Turn this into a wiki page under docs/wiki/"
            className="flex-1 resize-none rounded-md bg-raised border border-line px-3 py-2 outline-none focus:border-accent select-text"
          />
          <button onClick={run} disabled={!prompt.trim()} className="rounded-md bg-accent text-white px-2.5 py-1 self-end disabled:opacity-40" title="Plain prompt run in the repository root; file writes ask for permission">
            Run agent ⌘↵
          </button>
        </div>
        {runs.length > 0 && <RunList runs={runs} onOpen={onOpenRun} />}
      </section>

      <section className="flex-1 min-h-0 space-y-2">
        {editing ? (
          <MarkdownEditor initial={item.body} external={item.body} onSave={(body) => api.update(projectId, item.key, { body }).then(() => setEditing(false))} onCancel={() => setEditing(false)} />
        ) : (
          <>
            <button onClick={() => setEditing(true)} className="rounded-md border border-line px-2.5 py-1 hover:bg-raised">
              Edit
            </button>
            {item.body.trim() ? <Markdown text={item.body} /> : <p className="text-dim">Empty – click Edit or let an agent draft it.</p>}
          </>
        )}
      </section>
    </div>
  )
}
