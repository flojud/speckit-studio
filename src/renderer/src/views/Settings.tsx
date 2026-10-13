import { useEffect, useState } from 'react'
import type { AgentConfig, AgentOptions, ConfigChoice, GlobalAgentDefaults, PhaseConfig } from '../../../shared/types'

const COMMANDS = ['constitution', 'specify', 'clarify', 'plan', 'tasks', 'analyze', 'implement']
const KNOWN = [
  { id: 'claude-acp', label: 'Claude Code' },
  { id: 'antigravity-acp', label: 'Google Antigravity' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'codex-acp', label: 'Codex' }
]
const input = 'bg-raised border border-line rounded px-2 py-1 outline-none focus:border-accent select-text'
const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function Settings({ onAgentsChanged, onRestartGuide }: { onAgentsChanged: () => void; onRestartGuide: () => void }): React.JSX.Element {
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [phaseConfigs, setPhaseConfigs] = useState<Record<string, PhaseConfig>>({})
  const [globalDefaults, setGlobalDefaults] = useState<GlobalAgentDefaults>({})
  const [registryId, setRegistryId] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ error?: boolean; text: string }>()
  const [custom, setCustom] = useState({ name: '', command: '', args: '', env: '' })
  const [autoReads, setAutoReads] = useState(false)
  const [dangerouslySkip, setDangerouslySkip] = useState(false)
  // Models and efforts each agent reported (ACP configOptions); null = never loaded.
  const [options, setOptions] = useState<Record<string, AgentOptions | null>>({})
  const [probing, setProbing] = useState<string>()
  const [tools, setTools] = useState<{ id: string; required: boolean; version?: string; hint: string }[]>()
  const [toolPaths, setToolPaths] = useState<Record<string, string>>({})

  const reload = (): void => {
    window.api.listAgents().then(setAgents)
    onAgentsChanged()
  }
  useEffect(() => {
    Promise.all(agents.map(async (a) => [a.id, await window.api.agents.options(a.id)] as const)).then((e) => setOptions(Object.fromEntries(e)))
  }, [agents])
  useEffect(() => {
    window.api.listAgents().then(setAgents)
    window.api.agents.phaseConfigs().then(setPhaseConfigs)
    window.api.agents.globalDefaults().then(setGlobalDefaults)
    window.api.env.tools().then(setTools)
    window.api.settings.get<Record<string, string>>('toolPaths').then((v) => setToolPaths(v ?? {}))
    window.api.settings.get<boolean>('autoApproveReads').then((v) => setAutoReads(!!v))
    window.api.settings.get<boolean>('dangerouslySkipPermissions').then((v) => setDangerouslySkip(!!v))
  }, [])

  async function recheckTools(): Promise<void> {
    setTools(undefined)
    await window.api.settings.set('toolPaths', toolPaths)
    setTools(await window.api.env.tools(true))
  }

  async function probe(id: string): Promise<void> {
    setProbing(id)
    setMsg(undefined)
    try {
      const o = await window.api.agents.probe(id)
      setOptions((prev) => ({ ...prev, [id]: o }))
    } catch (e) {
      setMsg({ error: true, text: clean(e) })
    } finally {
      setProbing(undefined)
    }
  }

  // Choices across all agents, for global defaults and phases that follow the header selection.
  const union = (pick: (o: AgentOptions) => ConfigChoice[], withAgent: boolean): ConfigChoice[] => {
    const seen = new Map<string, ConfigChoice>()
    for (const a of agents)
      for (const c of options[a.id] ? pick(options[a.id]!) : []) if (!seen.has(c.value)) seen.set(c.value, withAgent ? { ...c, name: `${c.name} · ${a.name}` } : c)
    return [...seen.values()]
  }
  const allModels = union((o) => o.models, true)
  const allEfforts = union((o) => o.efforts, false)

  async function install(id: string): Promise<void> {
    setBusy(true)
    setMsg(undefined)
    try {
      const a = await window.api.agents.install(id)
      setMsg({ text: `Installed ${a.name}: ${a.command} ${a.args.join(' ')}` })
      setRegistryId('')
      reload()
    } catch (e) {
      setMsg({ error: true, text: clean(e) })
    } finally {
      setBusy(false)
    }
  }

  async function addCustom(): Promise<void> {
    if (!custom.name.trim() || !custom.command.trim()) return
    const env = Object.fromEntries(
      custom.env
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
    )
    const id = custom.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    await window.api.agents.save({ id, name: custom.name.trim(), command: custom.command.trim(), args: custom.args.split(' ').filter(Boolean), env })
    setCustom({ name: '', command: '', args: '', env: '' })
    reload()
  }

  const updatePhaseConfig = (command: string, update: Partial<PhaseConfig>): void => {
    const current = phaseConfigs[command] ?? {}
    const merged: PhaseConfig = { ...current, ...update }
    const next = { ...phaseConfigs }
    if (!merged.agentId && !merged.model && !merged.effort) {
      delete next[command]
    } else {
      next[command] = merged
    }
    setPhaseConfigs(next)
    window.api.agents.setPhaseConfigs(next)
  }

  const updateGlobalDefaults = (update: Partial<GlobalAgentDefaults>): void => {
    const next: GlobalAgentDefaults = { ...globalDefaults, ...update }
    setGlobalDefaults(next)
    window.api.agents.setGlobalDefaults(next)
  }

  return (
    <div className="px-6 py-5 space-y-8 max-w-4xl">
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Environment</h2>
        {!tools ? (
          <p className="text-dim">Checking tools…</p>
        ) : (
          <ul className="rounded-lg border border-line divide-y divide-line">
            {tools.map((t) => (
              <li key={t.id} className="px-3 py-2 space-y-1.5">
                <div className="flex items-center gap-3">
                  <span className={t.version ? 'text-[#4cb782]' : t.required ? 'text-[#eb5757]' : 'text-dim'}>{t.version ? '●' : '○'}</span>
                  <span className="w-20 font-medium">{t.id}</span>
                  <span className="w-24 text-dim">{t.version ?? (t.required ? 'missing (required)' : 'not found')}</span>
                  {!t.version && <code className="flex-1 truncate text-[12px] text-dim select-text">{t.hint}</code>}
                </div>
                {(!t.version || toolPaths[t.id]) && (
                  <input
                    className={`${input} ml-[5.5rem] w-[calc(100%-5.5rem)] font-mono text-[12px]`}
                    placeholder={`Installed but not found? Full path, e.g. output of \`which ${t.id}\``}
                    value={toolPaths[t.id] ?? ''}
                    onChange={(e) => setToolPaths((prev) => ({ ...prev, [t.id]: e.target.value }))}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        <button className="rounded-md border border-line px-2.5 py-1 text-dim hover:text-fg disabled:opacity-40" disabled={!tools} onClick={recheckTools}>
          Check again
        </button>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Agents</h2>
        <p className="text-dim">Agents are started over the Agent Client Protocol. Sign-in happens in the agent; the app stores no credentials.</p>
        <ul className="rounded-lg border border-line divide-y divide-line">
          {agents.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3 py-2">
              <span className="font-medium w-48 truncate">{a.name}</span>
              <code className="flex-1 truncate text-[12px] text-dim select-text" title={`${a.command} ${a.args.join(' ')}`}>
                {a.command} {a.args.join(' ')}
              </code>
              <button
                disabled={!!probing}
                onClick={() => probe(a.id)}
                className="text-dim hover:text-fg disabled:opacity-40 text-[12px]"
                title="Starts the agent once (no prompt) to read the models and efforts it offers"
              >
                {probing === a.id ? 'Loading…' : options[a.id] ? `${options[a.id]!.models.length} models · Refresh` : 'Load models'}
              </button>
              <button aria-label={`Remove ${a.name}`} onClick={() => window.api.agents.remove(a.id).then(reload)} className="text-dim hover:text-[#eb5757]">
                Remove
              </button>
            </li>
          ))}
        </ul>

        <div className="space-y-2">
          <h3 className="font-medium">Install from the ACP registry</h3>
          <div className="flex flex-wrap gap-2">
            {KNOWN.map((k) => (
              <button key={k.id} disabled={busy} onClick={() => install(k.id)} className="rounded-md border border-line px-2.5 py-1 text-dim hover:text-fg disabled:opacity-40">
                {k.label}
              </button>
            ))}
            {tools?.some((t) => t.id === 'agy' && t.version) && !agents.some((a) => a.id === 'agy' || a.command === 'agy') && (
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  await window.api.agents.save({ id: 'agy', name: 'Antigravity (local agy)', command: 'agy', args: [], env: {} })
                  reload()
                }}
                className="rounded-md border border-line px-2.5 py-1 text-dim hover:text-fg disabled:opacity-40"
              >
                + Local agy CLI
              </button>
            )}
            <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), registryId.trim() && install(registryId.trim()))}>
              <input className={input} placeholder="registry id…" value={registryId} onChange={(e) => setRegistryId(e.target.value)} />
              <button disabled={busy} className="rounded-md border border-line px-2.5 py-1 text-dim hover:text-fg disabled:opacity-40">
                {busy ? 'Installing…' : 'Install'}
              </button>
            </form>
          </div>
          {msg && <p className={msg.error ? 'text-[#eb5757]' : 'text-[#4cb782]'}>{msg.text}</p>}
        </div>

        <form className="space-y-2" onSubmit={(e) => (e.preventDefault(), addCustom())}>
          <h3 className="font-medium">Custom agent</h3>
          <div className="grid grid-cols-3 gap-2">
            <input className={input} placeholder="Name" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
            <input className={input} placeholder="Command" value={custom.command} onChange={(e) => setCustom({ ...custom, command: e.target.value })} />
            <input className={input} placeholder="Args (space separated)" value={custom.args} onChange={(e) => setCustom({ ...custom, args: e.target.value })} />
          </div>
          <textarea className={`${input} w-full`} rows={2} placeholder="Env, one KEY=value per line (e.g. ANTHROPIC_API_KEY=…)" value={custom.env} onChange={(e) => setCustom({ ...custom, env: e.target.value })} />
          <button className="rounded-md border border-line px-2.5 py-1 text-dim hover:text-fg">Add agent</button>
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Permissions</h2>
        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoReads}
              onChange={(e) => (setAutoReads(e.target.checked), window.api.settings.set('autoApproveReads', e.target.checked))}
            />
            Auto-approve read-only tool calls (read, search, think, fetch)
          </label>
          <label className="flex items-center gap-2 text-[#e5a00d] font-medium">
            <input
              type="checkbox"
              checked={dangerouslySkip}
              onChange={(e) => (setDangerouslySkip(e.target.checked), window.api.settings.set('dangerouslySkipPermissions', e.target.checked))}
            />
            Dangerously skip permissions
          </label>
        </div>
        <p className="text-dim text-[12px]">
          When &quot;Dangerously skip permissions&quot; is enabled, supported agents like <code>agy</code> and <code>claude</code> are started with the <code>--dangerously-skip-permissions</code> parameter and all tool calls are auto-approved.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Global Defaults</h2>
        <p className="text-dim">Default model and reasoning effort for all phases unless overridden below. Applied only when the run's agent offers the value. Lists come from the agents – use "Load models" above.</p>
        <div className="grid grid-cols-2 gap-4 max-w-md">
          <div className="space-y-1">
            <label className="text-xs text-dim font-medium">Default Model</label>
            <ChoiceSelect label="Default model" value={globalDefaults.model} choices={allModels} onChange={(model) => updateGlobalDefaults({ model })} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-dim font-medium">Default Effort</label>
            <ChoiceSelect label="Default effort" value={globalDefaults.effort} choices={allEfforts} onChange={(effort) => updateGlobalDefaults({ effort })} />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Agent per phase</h2>
        <p className="text-dim">Customize the agent, model, and reasoning effort per workflow phase. Unset options fall back to Global Defaults or header selection.</p>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-line text-xs font-semibold text-dim uppercase">
              <th className="py-2 pr-4">Phase</th>
              <th className="py-2 pr-4">Agent</th>
              <th className="py-2 pr-4">Model</th>
              <th className="py-2">Reasoning Effort</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/40">
            {COMMANDS.map((c) => {
              const cfg = phaseConfigs[c] ?? {}
              const agentOptions = cfg.agentId ? options[cfg.agentId] : undefined
              const models = cfg.agentId ? (agentOptions?.models ?? []) : allModels
              const efforts = cfg.agentId ? (agentOptions?.efforts ?? []) : allEfforts
              const noEffort = !!agentOptions && !agentOptions.efforts.length
              return (
                <tr key={c}>
                  <td className="pr-4 py-2 capitalize font-medium">{c}</td>
                  <td className="pr-4 py-2">
                    <select
                      className={input}
                      value={cfg.agentId ?? ''}
                      onChange={(e) => updatePhaseConfig(c, { agentId: e.target.value || undefined })}
                      aria-label={`Agent for ${c}`}
                    >
                      <option value="">Header selection</option>
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="pr-4 py-2">
                    <div className="flex items-center gap-2">
                      <ChoiceSelect
                        label={`Model for ${c}`}
                        value={cfg.model}
                        choices={models}
                        defaultLabel={globalDefaults.model ? `Global (${globalDefaults.model})` : 'Default'}
                        onChange={(model) => updatePhaseConfig(c, { model })}
                      />
                      {cfg.agentId && agentOptions === null && (
                        <button disabled={!!probing} onClick={() => probe(cfg.agentId!)} className="text-dim hover:text-fg disabled:opacity-40 text-[12px]">
                          {probing === cfg.agentId ? 'Loading…' : 'Load models'}
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="py-2">
                    <ChoiceSelect
                      label={`Effort for ${c}`}
                      value={cfg.effort}
                      choices={efforts}
                      defaultLabel={globalDefaults.effort ? `Default (${globalDefaults.effort})` : 'Default'}
                      disabled={noEffort && !cfg.effort}
                      title={noEffort ? 'This agent has no effort setting – pick a model variant instead' : undefined}
                      onChange={(effort) => updatePhaseConfig(c, { effort })}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Onboarding & Help</h2>
        <p className="text-dim">Walk through what Speckit Studio can do – projects, views, the Spec Kit lifecycle and agents.</p>
        <button onClick={onRestartGuide} className="rounded-md border border-line px-3 py-1 hover:bg-raised">
          Restart Onboarding Guide
        </button>
      </section>
    </div>
  )
}

/** Select over the values an agent offers. A stored value the agent no longer offers stays visible instead of being dropped. */
function ChoiceSelect(props: {
  label: string
  value?: string
  choices: ConfigChoice[]
  onChange: (value: string | undefined) => void
  defaultLabel?: string
  disabled?: boolean
  title?: string
}): React.JSX.Element {
  const { value, choices } = props
  return (
    <select
      className={`${input} w-52`}
      aria-label={props.label}
      title={props.title}
      disabled={props.disabled}
      value={value ?? ''}
      onChange={(e) => props.onChange(e.target.value || undefined)}
    >
      <option value="">{props.defaultLabel ?? 'Default'}</option>
      {value && !choices.some((c) => c.value === value) && <option value={value}>{value} (not available)</option>}
      {choices.map((c) => (
        <option key={c.value} value={c.value} title={c.description}>
          {c.name}
        </option>
      ))}
    </select>
  )
}
