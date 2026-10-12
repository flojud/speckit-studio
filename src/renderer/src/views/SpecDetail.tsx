import { useEffect, useState } from 'react'
import type { Phase, ProjectSnapshot, Run, Spec, Task } from '../../../shared/types'
import { STATUS_COLOR } from '../components/RunPanel'
import { resolvePage } from '../../../shared/wiki'
import { Markdown } from '../components/Markdown'
import { useFile } from '../useFile'
import { AnalysisBadge, Badge, Dot, GitBadge, PHASE_LABEL } from './Board'

const TASKS = '#tasks'
const RUNS = '#runs'
const ANALYSIS = '#analysis'
export const ACTIONS = ['clarify', 'plan', 'tasks', 'analyze', 'implement'] as const
const NEXT: Partial<Record<Phase, (typeof ACTIONS)[number]>> = {
  specified: 'clarify',
  clarified: 'plan',
  planned: 'tasks',
  tasked: 'analyze',
  implementing: 'implement'
}

const cleanError = (e: Error): string => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

interface Props {
  projectId: number
  snap: ProjectSnapshot
  spec: Spec
  rev: number
  onRun: (command: string, args?: string, opts?: { worktree?: boolean }) => void
  onOpenRun: (run: Run) => void
  onOpenWiki: (fileOrName: string) => void
  /** The spec is gone (draft deleted). */
  onClose: () => void
}

export function SpecDetail({ projectId, snap, spec, rev, onRun, onOpenRun, onOpenWiki, onClose }: Props): React.JSX.Element {
  const runs = useRuns(projectId, spec.key, rev)
  const tabs = [...spec.artifacts.map((a) => a.file), ...(spec.tasks.length ? [TASKS] : []), ...(spec.analysis ? [ANALYSIS] : []), ...(runs.length ? [RUNS] : [])]
  const [tab, setTab] = useState(tabs[0])
  const active = tabs.includes(tab) ? tab : tabs[0]
  const text = useFile(projectId, active && !active.startsWith('#') ? `${spec.dir}/${active}` : undefined, rev)
  const [report, setReport] = useState<string | null>()
  useEffect(() => {
    if (active === ANALYSIS && spec.analysis) window.api.readAnalysis(spec.analysis.runId).then(setReport)
  }, [active, spec.analysis])
  const [error, setError] = useState<string>()
  const [pr, setPr] = useState<string>()
  const gitAction = (fn: () => Promise<unknown>): void => {
    setError(undefined)
    fn().catch((e: Error) => setError(cleanError(e)))
  }
  const [promote, setPromote] = useState<{ title: string; body: string }>()
  const startPromote = (): void => {
    const selection = window.getSelection()?.toString().trim()
    const body = selection || (text ?? '').replace(/^#\s+.*\n+/, '')
    setPromote({ title: `${spec.title} – ${active.replace(/\.md$/, '')}`, body })
  }
  const savePromote = (): void => {
    if (!promote?.title.trim()) return
    setError(undefined)
    window.api.wiki
      .create(projectId, promote.title.trim(), `> Source: \`specs/${spec.key}/${active}\`\n\n${promote.body}\n`)
      .then((file) => (setPromote(undefined), onOpenWiki(file)))
      .catch((e: Error) => setError(cleanError(e)))
  }
  const toggle = (t: Task): void => {
    setError(undefined)
    window.api.toggleTask(projectId, spec.dir, t.id, !t.done).catch((e: Error) => setError(e.message))
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-5 pb-3 space-y-2">
        <h1 className="text-lg font-semibold">{spec.title}</h1>
        <div className="flex items-center gap-2 text-dim">
          <Dot phase={spec.phase} /> {PHASE_LABEL[spec.phase]}
          <span>·</span> <span>{spec.key}</span>
          {spec.openClarifications > 0 && <Badge color="#f2994a">{spec.openClarifications} open question{spec.openClarifications > 1 ? 's' : ''}</Badge>}
          <AnalysisBadge spec={spec} />
          {spec.blocked && <Badge color="#f2994a">🔒 blocked</Badge>}
          <GitBadge spec={spec} />
        </div>
        <PmRow projectId={projectId} snap={snap} spec={spec} />
        {error && <p className="text-[#eb5757] select-text">{error}</p>}
        {spec.phase === 'draft' ? (
          <DraftEditor projectId={projectId} spec={spec} onSpecify={() => onRun('specify')} onDeleted={onClose} onError={setError} />
        ) : (
        <div className="flex gap-1.5 pt-1">
          {ACTIONS.map((a) => (
            <button
              key={a}
              onClick={() => onRun(a)}
              className={`rounded-md px-2.5 py-1 capitalize border ${NEXT[spec.phase] === a ? 'bg-accent border-accent text-white' : 'border-line text-dim hover:text-fg hover:bg-raised'}`}
            >
              {a === 'implement' && spec.blocked ? '🔒 ' : ''}
              {a}
            </button>
          ))}
          <span className="mx-1 w-px bg-line" />
          {!spec.git?.worktree && snap.git && (
            <button onClick={() => onRun('implement', '', { worktree: true })} className="rounded-md px-2.5 py-1 border border-line text-dim hover:text-fg hover:bg-raised" title="Run implement in a git worktree on the spec branch, in parallel to other runs">
              Implement in worktree
            </button>
          )}
          {spec.git?.worktree && (
            <button onClick={() => gitAction(() => window.api.git.removeWorktree(projectId, spec.key))} className="rounded-md px-2.5 py-1 border border-line text-dim hover:text-fg hover:bg-raised">
              Remove worktree
            </button>
          )}
          {spec.git?.state === 'branch' && (
            <button
              onClick={() => gitAction(() => window.api.git.createPr(projectId, spec.key).then((url) => setPr(url)))}
              className="rounded-md px-2.5 py-1 border border-line text-dim hover:text-fg hover:bg-raised"
              title="git push + gh pr create --fill"
            >
              Create PR
            </button>
          )}
          {pr && (
            <a href={pr} target="_blank" rel="noreferrer" className="self-center text-accent text-[12px]">
              {pr}
            </a>
          )}
        </div>
        )}
      </div>
      <nav className="flex items-center gap-1 px-5 border-b border-line">
        {tabs.map((t) => {
          const stale = spec.artifacts.find((a) => a.file === t)?.stale
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2.5 py-2 -mb-px border-b-2 ${t === active ? 'border-accent text-fg' : 'border-transparent text-dim hover:text-fg'}`}
            >
              {t === ANALYSIS ? 'Analysis' : t === RUNS ? `Runs ${runs.length}` : t === TASKS ? `Checklist ${spec.tasks.filter((x) => x.done).length}/${spec.tasks.length}` : t.replace(/\.md$/, '')}
              {stale && <span className="ml-1.5 text-[#eb5757]" title="Upstream artifact changed after this one">●</span>}
            </button>
          )
        })}
        {active && !active.startsWith('#') && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={startPromote}
            className="ml-auto rounded-md px-2 py-1 text-dim hover:text-fg hover:bg-raised text-[12px]"
            title="Copy the selected text (or the whole file) into a new wiki page"
          >
            Promote to wiki
          </button>
        )}
      </nav>
      {promote && (
        <form
          className="flex items-center gap-2 px-6 py-2 border-b border-line bg-panel"
          onSubmit={(e) => (e.preventDefault(), savePromote())}
        >
          <span className="text-dim shrink-0">Wiki page title</span>
          <input
            autoFocus
            value={promote.title}
            onChange={(e) => setPromote({ ...promote, title: e.target.value })}
            onKeyDown={(e) => e.key === 'Escape' && setPromote(undefined)}
            className="flex-1 bg-raised border border-line rounded px-2 py-1 outline-none focus:border-accent select-text"
          />
          <span className="text-dim text-[12px] shrink-0">{promote.body.length} chars</span>
          <button className="rounded-md bg-accent text-white px-2.5 py-1">Create</button>
          <button type="button" onClick={() => setPromote(undefined)} className="text-dim hover:text-fg">
            Cancel
          </button>
        </form>
      )}
      <div className="flex-1 overflow-auto px-6 py-5">
        {!active ? (
          <p className="text-dim">No artifacts yet. Run {'specify'} to create the spec.</p>
        ) : active === ANALYSIS ? (
          report && <Markdown text={report} />
        ) : active === RUNS ? (
          <RunList runs={runs} onOpen={onOpenRun} />
        ) : active === TASKS ? (
          <>
            <TaskList tasks={spec.tasks} onToggle={toggle} />
          </>
        ) : text == null ? null : (
          <>
            <Markdown text={text} onWikiLink={onOpenWiki} exists={(n) => !!resolvePage(snap.wiki, n)} />
          </>
        )}
      </div>
    </div>
  )
}

/** Title + description of `draft.md`, Start specify and Delete. */
function DraftEditor(props: { projectId: number; spec: Spec; onSpecify: () => void; onDeleted: () => void; onError: (e?: string) => void }): React.JSX.Element {
  const { projectId, spec, onError } = props
  const [title, setTitle] = useState(spec.title)
  const [text, setText] = useState(spec.description ?? '')
  // Re-sync when draft.md changes on disk (values only change with the file).
  useEffect(() => (setTitle(spec.title), setText(spec.description ?? '')), [spec.title, spec.description])
  const dirty = title !== spec.title || text !== (spec.description ?? '')
  const run = (fn: () => Promise<unknown>): void => (onError(undefined), void fn().catch((e: Error) => onError(cleanError(e))))
  const save = (): void => run(() => window.api.drafts.update(projectId, spec.key, title, text))
  const remove = (): void =>
    void (window.confirm(`Delete draft ${spec.number} ${spec.title}?`) && run(() => window.api.drafts.remove(projectId, spec.key).then(props.onDeleted)))
  const field = 'w-full max-w-3xl rounded-md bg-raised border border-line px-3 py-1.5 outline-none focus:border-accent select-text'
  return (
    <div className="space-y-2 pt-1" onKeyDown={(e) => e.key === 's' && (e.metaKey || e.ctrlKey) && (e.preventDefault(), dirty && title.trim() && save())}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} placeholder="Title" aria-label="Draft title" />
      <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} className={`${field} resize-y`} placeholder="What to build and why…" aria-label="Draft description" />
      <div className="flex gap-1.5">
        <button
          onClick={props.onSpecify}
          disabled={dirty || !spec.description?.trim()}
          title={dirty ? 'Save the draft first' : spec.description?.trim() ? 'Run specify with this description' : 'Add a description to the draft first'}
          className="rounded-md bg-accent border border-accent text-white px-2.5 py-1 disabled:opacity-40"
        >
          Start specify
        </button>
        <button onClick={save} disabled={!dirty || !title.trim()} className="rounded-md px-2.5 py-1 border border-line text-dim hover:text-fg hover:bg-raised disabled:opacity-40">
          Save ⌘S
        </button>
        <button onClick={remove} className="ml-auto rounded-md px-2.5 py-1 border border-line text-dim hover:text-[#eb5757] hover:bg-raised">
          Delete draft
        </button>
      </div>
    </div>
  )
}

function TaskList({ tasks, onToggle }: { tasks: Task[]; onToggle: (t: Task) => void }): React.JSX.Element {
  const sections = [...new Set(tasks.map((t) => t.section))]
  return (
    <div className="max-w-3xl space-y-5">
      {sections.map((s) => (
        <section key={s}>
          <h3 className="text-dim font-medium mb-1.5">{s}</h3>
          <ul className="rounded-lg border border-line divide-y divide-line">
            {tasks
              .filter((t) => t.section === s)
              .map((t) => (
                <li key={t.id} className="flex items-start gap-3 px-3 py-2 select-text">
                  <button
                    onClick={() => onToggle(t)}
                    aria-label={`${t.done ? 'Uncheck' : 'Check'} ${t.id}`}
                    className={`mt-0.5 size-3.5 shrink-0 rounded border ${t.done ? 'bg-[#4cb782] border-[#4cb782]' : 'border-dim hover:border-fg'}`}
                  />
                  <span className="text-dim w-10 shrink-0">{t.id}</span>
                  <span className={t.done ? 'text-dim line-through' : ''}>{t.text}</span>
                  <span className="ml-auto flex gap-1 text-[11px] shrink-0">
                    {t.story && <Badge color="#4ea7fc">{t.story}</Badge>}
                    {t.parallel && <Badge color="#8a8b91">P</Badge>}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** Runs of a spec (or of the whole project); refreshed on file changes and whenever any run changes status. */
export function useRuns(projectId: number, specKey: string | undefined, rev: number): Run[] {
  const [runs, setRuns] = useState<Run[]>([])
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const off = window.api.onRunEvent((_id, _seq, e) => {
      if (e.type === 'status') setTick((t) => t + 1)
    })
    return () => off()
  }, [])
  useEffect(() => {
    window.api.listRuns(projectId, specKey).then(setRuns)
  }, [projectId, specKey, rev, tick])
  return runs
}

export function RunList({ runs, onOpen }: { runs: Run[]; onOpen: (r: Run) => void }): React.JSX.Element {
  return (
    <ul className="max-w-3xl rounded-lg border border-line divide-y divide-line">
      {runs.map((r) => (
        <li key={r.id}>
          <button onClick={() => onOpen(r)} className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-raised">
            <span className="size-2 rounded-full shrink-0" style={{ background: STATUS_COLOR[r.status] }} />
            <span className="truncate flex-1">{r.prompt.split('\n')[0]}</span>
            <span className="text-dim text-[11px]">{r.agent}</span>
            <span className="text-dim text-[11px] w-32 text-right">{new Date(r.started).toLocaleString()}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Epic / milestone / blocked-by pickers (app database). */
function PmRow({ projectId, snap, spec }: { projectId: number; snap: ProjectSnapshot; spec: Spec }): React.JSX.Element {
  const pm = window.api.pm
  const others = snap.specs.filter((s) => s.key !== spec.key && !spec.blockedBy?.includes(s.key))
  const select = 'bg-raised border border-line rounded px-1.5 py-0.5 outline-none text-fg'
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-dim">
      <label className="flex items-center gap-1">
        Epic
        <select className={select} value={spec.epicId ?? ''} onChange={(e) => pm.setMeta(projectId, spec.key, 'epic', e.target.value ? Number(e.target.value) : null)}>
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
        <select className={select} value={spec.milestoneId ?? ''} onChange={(e) => pm.setMeta(projectId, spec.key, 'milestone', e.target.value ? Number(e.target.value) : null)}>
          <option value="">–</option>
          {snap.milestones?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>
      </label>
      <span className="flex items-center gap-1">
        Blocked by
        {spec.blockedBy?.map((k) => {
          const b = snap.specs.find((s) => s.key === k)
          return (
            <span key={k} className="flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 text-fg" title={b ? b.phase : 'missing spec'}>
              {b ? <Dot phase={b.phase} /> : '?'} {k}
              <button aria-label={`Remove blocker ${k}`} className="text-dim hover:text-fg" onClick={() => pm.removeDep(projectId, spec.key, k)}>
                ×
              </button>
            </span>
          )
        })}
        {others.length > 0 && (
          <select className={select} value="" onChange={(e) => e.target.value && pm.addDep(projectId, spec.key, e.target.value)}>
            <option value="">+ add</option>
            {others.map((s) => (
              <option key={s.key} value={s.key}>
                {s.number} {s.title}
              </option>
            ))}
          </select>
        )}
      </span>
    </div>
  )
}
