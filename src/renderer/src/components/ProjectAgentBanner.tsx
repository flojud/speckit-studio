import { useEffect, useState } from 'react'
import type { AgentConfig, AgentOptions, ProjectAgentInfo, ProjectAgentPreferences } from '../../../shared/types'

const STATUS: Record<ProjectAgentInfo['status'], { label: string; cls: string; tip: string }> = {
  ready: { label: 'ready', cls: 'bg-[#4cb782]/15 text-[#4cb782]', tip: 'The agent command was found.' },
  'missing-binary': { label: 'command not found', cls: 'bg-[#eb5757]/15 text-[#eb5757]', tip: 'The agent command is not on PATH – install it or fix the agent in Settings.' },
  'unknown-agent': { label: 'unknown agent', cls: 'bg-[#eb5757]/15 text-[#eb5757]', tip: 'No agent with this ID is configured – pick another one or add it in Settings.' }
}

const field = 'bg-raised border border-line rounded px-1.5 py-0.5 text-[12px] text-fg outline-none focus:border-accent'

/** Which agent runs this project (`.specify/integration.json`), plus model, effort and instructions for its runs (app DB). */
export function ProjectAgentBanner(props: { projectId: number; rev: number; agents: AgentConfig[]; fallbackAgentId: string; onOpenSettings?: () => void }): React.JSX.Element | null {
  const { projectId, rev, agents, fallbackAgentId, onOpenSettings } = props
  const [info, setInfo] = useState<ProjectAgentInfo>()
  const [options, setOptions] = useState<AgentOptions | null>(null)
  const [instructions, setInstructions] = useState('')
  const [error, setError] = useState<string>()

  useEffect(() => {
    let alive = true
    window.api.projectAgent.get(projectId, fallbackAgentId).then((i) => {
      if (!alive) return
      setInfo(i)
      setInstructions(i.preferences.instructions ?? '')
    })
    return () => {
      alive = false
    }
  }, [projectId, rev, fallbackAgentId])

  useEffect(() => {
    let alive = true
    if (info) window.api.agents.options(info.agentId).then((o) => alive && setOptions(o))
    return () => {
      alive = false
    }
  }, [info?.agentId])

  if (!info) return null

  const save = async (agentId: string | null, preferences: ProjectAgentPreferences): Promise<void> => {
    setError(undefined)
    try {
      await window.api.projectAgent.set(projectId, agentId, preferences)
      setInfo(await window.api.projectAgent.get(projectId, fallbackAgentId))
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  const assigned = info.inherited ? null : info.agentId
  const prefs = info.preferences
  const s = STATUS[info.status]

  /** A select of what the agent reported, else free text (the agent hasn't been probed yet). */
  const choice = (key: 'model' | 'effort', choices: { value: string; name: string }[] | undefined, placeholder: string): React.JSX.Element =>
    choices?.length ? (
      <select value={prefs[key] ?? ''} onChange={(e) => void save(assigned, { ...prefs, [key]: e.target.value })} className={field} aria-label={`Project ${key}`}>
        <option value="">{placeholder}</option>
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.name}
          </option>
        ))}
        {prefs[key] && !choices.some((c) => c.value === prefs[key]) && <option value={prefs[key]}>{prefs[key]} (not offered)</option>}
      </select>
    ) : (
      <input
        key={`${key}-${prefs[key] ?? ''}`}
        defaultValue={prefs[key] ?? ''}
        placeholder={placeholder}
        onBlur={(e) => e.target.value.trim() !== (prefs[key] ?? '') && void save(assigned, { ...prefs, [key]: e.target.value.trim() })}
        className={`${field} w-28`}
        aria-label={`Project ${key}`}
      />
    )

  return (
    <div className="shrink-0 border-b border-line bg-panel px-6 py-2 text-[12px] space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] font-semibold text-dim uppercase tracking-wider">Project agent</span>
        <select
          value={assigned ?? ''}
          onChange={(e) => void save(e.target.value || null, prefs)}
          className={field}
          aria-label="Project agent"
          title="Saved in .specify/integration.json (studio_agent)"
        >
          <option value="">Inherit header agent ({agents.find((a) => a.id === fallbackAgentId)?.name ?? fallbackAgentId})</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          {assigned && !agents.some((a) => a.id === assigned) && <option value={assigned}>{assigned} (unknown)</option>}
        </select>
        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${s.cls}`} title={s.tip}>
          {s.label}
        </span>
        {info.status !== 'ready' && onOpenSettings && (
          <button onClick={onOpenSettings} className="text-accent hover:underline text-[11px]">
            Settings
          </button>
        )}
        {info.command && (
          <span className="font-mono text-[11px] text-dim truncate max-w-[24rem]" title={info.command}>
            {info.command}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <span className="text-dim text-[11px]">Model</span>
          {choice('model', options?.models, 'default')}
          <span className="text-dim text-[11px]">Effort</span>
          {choice('effort', options?.efforts, 'default')}
        </span>
      </div>
      <details className="group" open={!!prefs.instructions}>
        <summary className="cursor-pointer text-[11px] text-dim hover:text-fg select-none">Project instructions{prefs.instructions ? '' : ' (none)'} – appended to every run prompt</summary>
        <textarea
          rows={2}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onBlur={() => instructions.trim() !== (prefs.instructions ?? '') && void save(assigned, { ...prefs, instructions: instructions.trim() })}
          placeholder="e.g. Use pnpm, never touch the generated/ folder."
          className={`${field} mt-1 w-full resize-y py-1`}
        />
      </details>
      {error && <div className="text-[#eb5757] text-[11px]">{error}</div>}
    </div>
  )
}
