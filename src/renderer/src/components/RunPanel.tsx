import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileChange, Run, RunEvent, RunStatus } from '../../../shared/types'
import { foldEvents } from '../../../shared/runs'
import { parseQuickReplies } from '../../../shared/clarify'
import { Markdown } from './Markdown'

export const STATUS_COLOR: Record<RunStatus, string> = {
  running: '#f2c94c',
  waiting: '#4ea7fc',
  done: '#4cb782',
  failed: '#eb5757',
  cancelled: '#8a8b91'
}

const TOOL_ICON: Record<string, string> = { pending: '○', in_progress: '◐', completed: '●', failed: '✕' }

/** Loads a run's stored events and appends live ones (keyed by seq, so overlap is harmless). */
function useRunEvents(runId: number): RunEvent[] {
  const [byseq, setBySeq] = useState(new Map<number, RunEvent>())
  useEffect(() => {
    setBySeq(new Map())
    const off = window.api.onRunEvent((id, seq, e) => id === runId && setBySeq((m) => new Map(m).set(seq, e)))
    window.api.runEvents(runId).then((events) =>
      setBySeq((m) => {
        const next = new Map(m)
        events.forEach((e, i) => next.set(i + 1, e))
        return next
      })
    )
    return () => off()
  }, [runId])
  return useMemo(() => [...byseq.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e), [byseq])
}

export function RunPanel({ run, onClose }: { run: Run; onClose: () => void }): React.JSX.Element {
  const events = useRunEvents(run.id)
  const r = useMemo(() => foldEvents(events), [events])
  const [reply, setReply] = useState('')
  const [changes, setChanges] = useState<FileChange[] | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  const hasBaseline = useMemo(() => events.some((e) => e.type === 'baseline'), [events])

  useEffect(() => {
    if (hasBaseline && r.status !== 'running') {
      window.api.agentConfig.changes(run.id).then(setChanges)
    } else {
      setChanges(null)
    }
  }, [hasBaseline, r.status, run.id])

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [events.length, changes])

  const send = (text = reply): void => {
    if (!text.trim()) return
    window.api.replyRun(run.id, text.trim())
    setReply('')
  }
  const lastAgent = r.items.findLast((i) => i.kind === 'message' && i.role === 'agent')
  const quick = r.status === 'waiting' && lastAgent?.kind === 'message' ? parseQuickReplies(lastAgent.text) : undefined

  return (
    <aside className="w-[440px] shrink-0 border-l border-line bg-panel flex flex-col min-h-0">
      <div className="h-11 shrink-0 flex items-center gap-2 px-3 border-b border-line">
        <span className="size-2 rounded-full" style={{ background: STATUS_COLOR[r.status] }} />
        <span className="font-medium capitalize">{r.status}</span>
        <span className="text-dim truncate">· {run.agent}</span>
        {r.activeConfig?.model && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-raised border border-line text-dim font-mono">
            {r.activeConfig.model}
          </span>
        )}
        {r.activeConfig?.effort && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-raised border border-line text-dim font-mono">
            {r.activeConfig.effort}
          </span>
        )}
        <span className="ml-auto flex gap-1">
          {r.status === 'running' && <Btn onClick={() => window.api.cancelRun(run.id)}>Cancel</Btn>}
          {r.status === 'waiting' && <Btn onClick={() => window.api.finishRun(run.id)}>Finish</Btn>}
          <Btn onClick={onClose} title="Close panel">✕</Btn>
        </span>
      </div>

      {r.plan.length > 0 && (
        <ul className="px-4 py-2 border-b border-line space-y-0.5 text-[12px]">
          {r.plan.map((p, i) => (
            <li key={i} className={p.status === 'completed' ? 'text-dim line-through' : p.status === 'in_progress' ? 'text-fg' : 'text-dim'}>
              {TOOL_ICON[p.status] ?? '○'} {p.content}
            </li>
          ))}
        </ul>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {r.items.map((item, i) =>
          item.kind === 'tool' ? (
            <div key={i} className="flex items-center gap-2 text-[12px] text-dim">
              <span style={{ color: item.status === 'failed' ? '#eb5757' : item.status === 'completed' ? '#4cb782' : undefined }}>
                {TOOL_ICON[item.status] ?? '○'}
              </span>
              <span className="truncate">{item.title}</span>
            </div>
          ) : item.role === 'thought' ? (
            <details key={i} className="text-dim text-[12px]">
              <summary className="cursor-pointer">Thinking…</summary>
              <p className="whitespace-pre-wrap select-text mt-1">{item.text}</p>
            </details>
          ) : item.role === 'notice' ? (
            <p key={i} className="text-[12px] text-[#4ea7fc] italic">{item.text}</p>
          ) : item.role === 'user' ? (
            <div key={i} className="rounded-lg bg-raised px-3 py-2 whitespace-pre-wrap select-text">{item.text}</div>
          ) : (
            <Markdown key={i} text={item.text} />
          )
        )}
        {r.error && <p className="text-[#eb5757] whitespace-pre-wrap select-text text-[12px]">{r.error}</p>}
        {changes && (
          <div className="border-t border-line pt-3 space-y-2 text-[12px]">
            <div className="font-semibold text-fg">Changes</div>
            {changes.length === 0 ? (
              <p className="text-dim">No files changed</p>
            ) : (
              changes.map((c) => (
                <div key={c.path} className="rounded border border-line bg-raised overflow-hidden">
                  <div className="px-2.5 py-1 font-mono text-[11px] bg-raised border-b border-line flex items-center justify-between">
                    <span className="font-medium text-fg">{c.path}</span>
                    <span className="text-dim text-[10px] uppercase">
                      {c.status === 'too-large' ? 'not tracked (too large)' : c.status}
                    </span>
                  </div>
                  {c.status === 'too-large' ? (
                    <div className="p-2 text-dim italic">not tracked (too large)</div>
                  ) : (
                    <div className="font-mono text-[11px] p-2 overflow-x-auto space-y-0.5">
                      {c.lines.map((l, li) => (
                        <div
                          key={li}
                          className={
                            l.op === '+'
                              ? 'text-[#4cb782] bg-[#4cb782]/10'
                              : l.op === '-'
                              ? 'text-[#eb5757] bg-[#eb5757]/10'
                              : 'text-dim'
                          }
                        >
                          <span className="inline-block w-4 select-none">{l.op}</span>
                          <span>{l.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
        <div ref={bottom} />
      </div>

      {r.permission ? (
        <div className="border-t border-line p-3 space-y-2 bg-raised">
          <div className="text-[12px] text-dim">Permission requested</div>
          <div className="font-medium">{r.permission.title}</div>
          <div className="flex flex-wrap gap-2">
            {r.permission.options.map((o) => (
              <button
                key={o.optionId}
                onClick={() => window.api.answerPermission(run.id, r.permission!.requestId, o.optionId)}
                className={`rounded-md px-2.5 py-1 ${o.kind.startsWith('allow') ? 'bg-accent text-white' : 'bg-line hover:bg-dim/30'}`}
              >
                {o.name}
              </button>
            ))}
          </div>
        </div>
      ) : (
        r.status === 'waiting' && (
          <div className="border-t border-line p-3 space-y-2">
          {quick && (
            <div className="flex flex-wrap gap-1.5">
              {quick.recommended && (
                <button onClick={() => send('yes')} className="rounded-md bg-accent text-white px-2 py-1">
                  Accept recommended ({quick.recommended})
                </button>
              )}
              {quick.options.map((o) => (
                <button key={o.letter} onClick={() => send(o.letter)} title={o.label} className="rounded-md border border-line px-2 py-1 text-left hover:bg-raised max-w-full truncate">
                  <b>{o.letter}</b> {o.label}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && send()}
              placeholder="Reply to the agent… (⌘↵)"
              rows={2}
              className="flex-1 resize-none rounded-md bg-raised border border-line px-2 py-1.5 outline-none focus:border-accent select-text"
            />
            <Btn onClick={() => send()}>Send</Btn>
          </div>
          </div>
        )
      )}
    </aside>
  )
}

export const Btn = (props: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element => (
  <button {...props} className={`no-drag rounded-md px-2 py-1 text-dim hover:bg-raised hover:text-fg disabled:opacity-40 ${props.className ?? ''}`} />
)
