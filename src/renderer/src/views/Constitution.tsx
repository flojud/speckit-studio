import { useState } from 'react'
import type { ProjectSnapshot } from '../../../shared/types'
import { Markdown } from '../components/Markdown'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { useFile } from '../useFile'

interface Props {
  projectId: number
  snap: ProjectSnapshot
  rev: number
  onAmend: (instructions: string) => void
  onOpenSpec: (key: string) => void
}

const FILE = '.specify/memory/constitution.md'

export function Constitution({ projectId, snap, rev, onAmend, onOpenSpec }: Props): React.JSX.Element {
  const text = useFile(projectId, FILE, rev)
  const [editing, setEditing] = useState(false)
  const [amend, setAmend] = useState<string>()
  const c = snap.constitution
  const outdated = snap.specs.filter((s) => {
    const plan = s.artifacts.find((a) => a.file === 'plan.md')
    return plan && c?.mtime && c.mtime > plan.mtime
  })

  if (editing && text != null)
    return (
      <div className="px-6 py-5 h-full">
        <MarkdownEditor initial={text} onCancel={() => setEditing(false)} onSave={(t) => window.api.writeFile(projectId, FILE, t).then(() => setEditing(false))} />
      </div>
    )

  return (
    <div className="px-6 py-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-dim">
        {c?.version && (
          <span>
            Version <span className="text-fg">{c.version}</span> · ratified {c.ratified} · amended {c.amended}
          </span>
        )}
        <span className="ml-auto flex gap-2">
          {text != null && (
            <button onClick={() => setEditing(true)} className="rounded-md border border-line px-2.5 py-1 hover:text-fg">
              Edit
            </button>
          )}
          <button onClick={() => setAmend('')} className="rounded-md bg-accent text-white px-2.5 py-1">
            {text == null ? 'Create with agent' : 'Amend with agent'}
          </button>
        </span>
      </div>

      {amend !== undefined && (
        <form
          className="rounded-lg border border-line bg-panel p-3 space-y-2 max-w-3xl"
          onSubmit={(e) => {
            e.preventDefault()
            onAmend(amend.trim())
            setAmend(undefined)
          }}
        >
          <p className="text-dim">
            What should change? The agent runs <code>{snap.commandPrefix}constitution</code>, bumps the version and syncs dependent templates.
          </p>
          <textarea
            autoFocus
            rows={4}
            value={amend}
            onChange={(e) => setAmend(e.target.value)}
            className="w-full resize-none rounded-md bg-raised border border-line px-3 py-2 outline-none focus:border-accent select-text"
            placeholder="Add a principle: all UI must be keyboard accessible…"
          />
          <div className="flex gap-2">
            <button className="rounded-md bg-accent text-white px-2.5 py-1">Run</button>
            <button type="button" onClick={() => setAmend(undefined)} className="rounded-md px-2.5 py-1 text-dim hover:text-fg">
              Cancel
            </button>
          </div>
        </form>
      )}

      {outdated.length > 0 && (
        <div className="rounded-lg border border-[#f2994a55] bg-[#f2994a11] p-3 max-w-3xl">
          <div className="text-[#f2994a] mb-1">Planned before the last constitution change – re-run plan to re-check:</div>
          <div className="flex flex-wrap gap-2">
            {outdated.map((s) => (
              <button key={s.key} onClick={() => onOpenSpec(s.key)} className="rounded bg-raised px-2 py-0.5 hover:text-fg">
                {s.number} {s.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {text === null ? <p className="text-dim">No constitution yet.</p> : text && <Markdown text={text} />}
    </div>
  )
}
