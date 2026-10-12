import { useState } from 'react'
import { WORK_ITEM_CATEGORIES, type WorkItemCategory } from '../../../shared/types'
import { CATEGORY_LABEL } from '../views/Board'

/** Creates `work-items/WI-###-<slug>.md`; ⌘↵ creates, Esc cancels. */
export function NewWorkItemDialog({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (title: string, category: WorkItemCategory, content: string) => Promise<void> }): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<WorkItemCategory>('general')
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const submit = (): void => {
    if (!title.trim()) return
    setError(undefined)
    onSubmit(title, category, text).catch((e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
  }
  const onKey = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
    else if (e.key === 'Escape') onCancel()
  }
  const field = 'w-full rounded-md bg-raised border border-line px-3 py-2 outline-none focus:border-accent select-text'
  return (
    <div className="fixed inset-0 z-10 grid place-items-center bg-black/50" onClick={onCancel}>
      <div className="w-[560px] rounded-xl border border-line bg-panel p-4 space-y-3" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <h2 className="font-semibold">New work item</h2>
        <p className="text-dim">Non-code work – business plans, marketing, research, docs. Saved as Markdown under <code>work-items/</code>.</p>
        <div className="flex gap-2">
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className={field} placeholder="Title, e.g. Q4 Marketing Strategy" />
          <select value={category} onChange={(e) => setCategory(e.target.value as WorkItemCategory)} className="rounded-md bg-raised border border-line px-2 outline-none" aria-label="Category">
            {WORK_ITEM_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} className={`${field} resize-none`} placeholder="Initial description (Markdown, optional)" />
        {error && <p className="text-[#eb5757] select-text">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-md px-2.5 py-1 text-dim hover:text-fg">
            Cancel
          </button>
          <button onClick={submit} disabled={!title.trim()} className="rounded-md bg-accent text-white px-2.5 py-1 disabled:opacity-40">
            Create work item ⌘↵
          </button>
        </div>
      </div>
    </div>
  )
}
