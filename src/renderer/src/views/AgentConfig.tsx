import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentConfig as AcpAgentConfig,
  AgentConfigState,
  ConfigAgent,
  ConfigItem,
  ConfigKind,
  Finding,
  McpServerConfig,
  SectionDiff
} from '../../../shared/types'
import { Markdown } from '../components/Markdown'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { McpServerEditor, McpServerRow } from '../components/McpServerConfig'
import { ProjectAgentBanner } from '../components/ProjectAgentBanner'
import { useFile } from '../useFile'

interface Props {
  projectId: number
  rev: number
  /** Header agent selection, used when the project has no agent of its own */
  agentId: string
  /** Agent assigned to the project; runs always use it */
  projectAgentId?: string
  onOpenRun?: (runId: number) => void
  onOpenSettings?: () => void
}

const cleanError = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatRelative(mtime: number): string {
  const diffSec = Math.max(0, Math.round((Date.now() - mtime) / 1000))
  if (diffSec < 60) return 'just now'
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHour = Math.round(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h ago`
  const diffDay = Math.round(diffHour / 24)
  return `${diffDay}d ago`
}

const KIND_LABEL: Record<ConfigKind, string> = {
  context: 'Context Files',
  skill: 'Skills',
  subagent: 'Subagents'
}

const KIND_DESC: Record<ConfigKind, string> = {
  context: 'Instructions agents read automatically on every turn (CLAUDE.md, GEMINI.md, AGENTS.md).',
  skill: 'Reusable multi-step workflows triggered by slash commands or agent intent.',
  subagent: 'Specialized agents with dedicated system prompts and restricted tools.'
}

const AGENT_LABEL: Record<ConfigAgent, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  shared: 'Shared'
}

const MCP_FILE = '.mcp.json'
/** Selection key of an MCP server; `mcp:` alone = new server. */
const MCP_KEY = 'mcp:'
const skillDir = (skill: ConfigItem): string => skill.path.replace(/\/SKILL\.md$/, '')

/** A listed item, or a file shown like one: an auxiliary skill file (`aux`) or the raw `.mcp.json` (`raw`). */
type Selected = ConfigItem & { aux?: boolean; raw?: boolean }

function resolveSelected(st: AgentConfigState, path: string | null): Selected | undefined {
  if (!path) return undefined
  const item = st.items.find((i) => i.path === path)
  if (item) return item
  if (path === MCP_FILE)
    return st.mcp.exists ? { path, kind: 'context', agent: 'shared', name: path, size: 0, mtime: 0, readOnly: false, raw: true } : undefined
  const skill = st.items.find((i) => i.kind === 'skill' && i.extraFiles?.some((f) => `${skillDir(i)}/${f}` === path))
  return skill && { ...skill, path, name: path.slice(skillDir(skill).length + 1), extraFiles: undefined, aux: true }
}

/** Whether a selection key still points at something after a reload. */
const resolvable = (st: AgentConfigState, key: string): boolean =>
  key.startsWith(MCP_KEY) ? key === MCP_KEY || st.mcp.servers.some((s) => `${MCP_KEY}${s.name}` === key) : !!resolveSelected(st, key)

export function AgentConfig({ projectId, rev, agentId, projectAgentId, onOpenRun, onOpenSettings }: Props): React.JSX.Element {
  const [state, setState] = useState<AgentConfigState | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [error, setError] = useState<string>()
  const [agents, setAgents] = useState<AcpAgentConfig[]>([])
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set())
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const newMenuRef = useRef<HTMLDivElement>(null)

  // Dialog states
  const [createDialog, setCreateDialog] = useState<{
    open: boolean
    kind: ConfigKind
    agent: ConfigAgent
    name: string
    description: string
    error?: string
  }>({ open: false, kind: 'context', agent: 'claude', name: '', description: '' })

  const [optimizeDialog, setOptimizeDialog] = useState<{
    open: boolean
    target: string | null
    agentId: string
    instructions: string
    error?: string
  }>({ open: false, target: null, agentId: '', instructions: '' })

  const [fileDialog, setFileDialog] = useState<{ skillDir: string; name: string; content: string; error?: string } | null>(null)

  // Load state and agents
  useEffect(() => {
    let alive = true
    window.api.agentConfig.list(projectId).then((st) => {
      if (alive) {
        setState(st)
        setSelectedPath((prev) => (prev && resolvable(st, prev) ? prev : (st.items[0]?.path ?? null)))
      }
    })
    window.api.listAgents().then((as) => alive && setAgents(as))
    return () => {
      alive = false
    }
  }, [projectId, rev])

  // Close dropdown on outside click
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const selectedItem = useMemo(() => (state ? resolveSelected(state, selectedPath) : undefined), [state, selectedPath])
  const synthetic = !!(selectedItem?.aux || selectedItem?.raw)
  const isMarkdown = !!selectedItem?.path.endsWith('.md')
  const mcpName = selectedPath?.startsWith(MCP_KEY) ? selectedPath.slice(MCP_KEY.length) : undefined
  const selectedServer = mcpName ? (state?.mcp.servers.find((s) => s.name === mcpName) ?? null) : null

  const content = useFile(projectId, selectedItem?.path, rev)

  const findingsByFile = useMemo(() => {
    const map = new Map<string, Finding[]>()
    state?.findings.forEach((f) => {
      const list = map.get(f.file) ?? []
      list.push(f)
      map.set(f.file, list)
    })
    return map
  }, [state?.findings])

  const selectItem = (path: string): void => {
    if (path === selectedPath) return
    if (isDirty && !window.confirm('Discard unsaved changes?')) return
    setSelectedPath(path)
    setEditing(false)
    setIsDirty(false)
  }

  const toggleSkillExpand = (path: string): void => {
    setExpandedSkills((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const openCreate = (kind: ConfigKind, agent: ConfigAgent): void => {
    setNewMenuOpen(false)
    setCreateDialog({ open: true, kind, agent, name: '', description: '' })
  }

  const handleCreate = async (): Promise<void> => {
    setError(undefined)
    try {
      const newPath = await window.api.agentConfig.create(
        projectId,
        createDialog.kind,
        createDialog.agent,
        createDialog.name.trim(),
        createDialog.description.trim()
      )
      setCreateDialog((d) => ({ ...d, open: false }))
      setSelectedPath(newPath)
      setEditing(true)
    } catch (e) {
      setCreateDialog((d) => ({ ...d, error: cleanError(e) }))
    }
  }

  const handleDelete = async (item: Selected): Promise<void> => {
    if (item.aux) return deleteAuxFile(item.path)
    if (item.kind === 'context') return
    const extras =
      item.extraFiles && item.extraFiles.length > 0
        ? ` and ${item.extraFiles.length} extra file(s) (${item.extraFiles.join(', ')})`
        : ''
    const msg =
      item.kind === 'skill'
        ? `Delete skill "${item.name}"? This will remove SKILL.md${extras}.`
        : `Delete subagent "${item.name}"? This will remove ${item.path}.`
    if (!window.confirm(msg)) return
    try {
      await window.api.agentConfig.remove(projectId, item.path)
      if (selectedPath === item.path) {
        setSelectedPath(null)
      }
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const deleteAuxFile = async (path: string): Promise<void> => {
    if (!window.confirm(`Delete ${path}? SKILL.md and the other files of the skill stay.`)) return
    try {
      await window.api.agentConfig.deleteSkillFile(projectId, path)
      if (selectedPath === path) setSelectedPath(null)
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const handleCreateFile = async (): Promise<void> => {
    if (!fileDialog) return
    try {
      const path = await window.api.agentConfig.createSkillFile(projectId, fileDialog.skillDir, fileDialog.name, fileDialog.content)
      setFileDialog(null)
      setExpandedSkills((prev) => new Set(prev).add(`${fileDialog.skillDir}/SKILL.md`))
      setSelectedPath(path)
      setEditing(false)
      setIsDirty(false)
    } catch (e) {
      setFileDialog((d) => d && { ...d, error: cleanError(e) })
    }
  }

  const saveServer = async (server: McpServerConfig, oldName?: string): Promise<void> => {
    await window.api.mcp.save(projectId, server, oldName)
    setIsDirty(false)
    setSelectedPath(`${MCP_KEY}${server.name}`)
  }

  const deleteServer = async (name: string): Promise<void> => {
    if (!window.confirm(`Remove MCP server "${name}" from .mcp.json?`)) return
    try {
      await window.api.mcp.remove(projectId, name)
      setIsDirty(false)
      setSelectedPath(null)
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const toggleServer = (name: string, enabled: boolean): void =>
    void window.api.mcp.toggle(projectId, name, enabled).catch((e) => setError(cleanError(e)))

  const handleShare = async (diff: SectionDiff): Promise<void> => {
    const msg = `Move the following identical sections to AGENTS.md?\n\n${diff.shared.map((s) => `• ${s}`).join('\n')}`
    if (!window.confirm(msg)) return
    try {
      await window.api.agentConfig.share(projectId, diff.dir)
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const openOptimize = (target: string | null): void => {
    // Owner preselection (R11):
    // ponytail: name heuristic matches agent id or name with owner; vendor field is upgrade path
    const targetItem = target ? state?.items.find((i) => i.path === target) : undefined
    const owner = targetItem?.agent === 'claude' || targetItem?.agent === 'gemini' ? targetItem.agent : undefined
    const matched = owner
      ? agents.find((a) => new RegExp(owner, 'i').test(`${a.id} ${a.name}`))?.id
      : undefined
    const pick = projectAgentId ?? matched ?? (agents.find((a) => a.id === agentId)?.id ?? agents[0]?.id ?? '')
    setOptimizeDialog({ open: true, target, agentId: pick, instructions: '' })
  }

  const handleOptimize = async (): Promise<void> => {
    if (!optimizeDialog.agentId) return
    try {
      const runId = await window.api.agentConfig.optimize(
        projectId,
        optimizeDialog.agentId,
        optimizeDialog.target,
        optimizeDialog.instructions
      )
      setOptimizeDialog((d) => ({ ...d, open: false }))
      onOpenRun?.(runId)
    } catch (e) {
      setOptimizeDialog((d) => ({ ...d, error: cleanError(e) }))
    }
  }

  const totalFindings = state?.findings.length ?? 0
  const contextItems = state?.items.filter((i) => i.kind === 'context') ?? []
  const skillItems = state?.items.filter((i) => i.kind === 'skill') ?? []
  const subagentItems = state?.items.filter((i) => i.kind === 'subagent') ?? []
  const selectedFindings = selectedItem ? findingsByFile.get(selectedItem.path) ?? [] : []
  const mcp = state?.mcp
  const mcpFindings = (name: string): Finding[] => state?.findings.filter((f) => f.server === name) ?? []
  const mcpFileFindings = state?.findings.filter((f) => f.file === MCP_FILE && !f.server) ?? []

  return (
    <div className="flex flex-col h-full">
      {/* Top Header */}
      <div className="h-12 shrink-0 border-b border-line px-6 flex items-center gap-3 bg-panel">
        <h1 className="font-semibold text-fg text-sm">Agent Config</h1>
        <div className="flex items-center gap-2 text-[12px]">
          {totalFindings === 0 ? (
            <span className="text-[#4cb782] font-medium">✓ No issues found</span>
          ) : (
            <span className="px-2 py-0.5 rounded-full bg-[#f2994a]/15 text-[#f2994a] font-medium">
              {totalFindings} {totalFindings === 1 ? 'issue' : 'issues'}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => openOptimize(null)}
            className="rounded-md border border-line bg-raised px-2.5 py-1 text-[12px] text-fg hover:bg-dim/20"
          >
            Optimize project
          </button>
          <div className="relative" ref={newMenuRef}>
            <button
              onClick={() => setNewMenuOpen((v) => !v)}
              className="rounded-md bg-accent text-white px-2.5 py-1 text-[12px] flex items-center gap-1"
            >
              <span>New</span>
              <span className="text-[10px]">▾</span>
            </button>
            {newMenuOpen && (
              <div className="absolute right-0 mt-1 w-48 rounded-md bg-raised border border-line shadow-lg py-1 z-20 text-[12px]">
                <div className="px-2.5 py-1 text-dim text-[11px] font-medium uppercase tracking-wider">Context File</div>
                <button
                  onClick={() => openCreate('context', 'claude')}
                  className="w-full text-left px-3 py-1 hover:bg-dim/20 text-fg"
                >
                  Claude (CLAUDE.md)
                </button>
                <button
                  onClick={() => openCreate('context', 'gemini')}
                  className="w-full text-left px-3 py-1 hover:bg-dim/20 text-fg"
                >
                  Gemini (GEMINI.md)
                </button>
                <button
                  onClick={() => openCreate('context', 'shared')}
                  className="w-full text-left px-3 py-1 hover:bg-dim/20 text-fg"
                >
                  Shared (AGENTS.md)
                </button>
                <div className="border-t border-line my-1" />
                <div className="px-2.5 py-1 text-dim text-[11px] font-medium uppercase tracking-wider">Skill</div>
                <button
                  onClick={() => openCreate('skill', 'claude')}
                  className="w-full text-left px-3 py-1 hover:bg-dim/20 text-fg"
                >
                  Claude Skill
                </button>
                <button
                  onClick={() => openCreate('skill', 'gemini')}
                  className="w-full text-left px-3 py-1 hover:bg-dim/20 text-fg"
                >
                  Gemini Skill
                </button>
                <div className="border-t border-line my-1" />
                <div className="px-2.5 py-1 text-dim text-[11px] font-medium uppercase tracking-wider">Subagent</div>
                <button
                  onClick={() => openCreate('subagent', 'claude')}
                  className="w-full text-left px-3 py-1 hover:bg-dim/20 text-fg"
                >
                  Claude Subagent
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-[#eb575722] text-[#eb5757] px-6 py-2 text-[12px] flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(undefined)}>✕</button>
        </div>
      )}

      <ProjectAgentBanner projectId={projectId} rev={rev} agents={agents} fallbackAgentId={agentId} onOpenSettings={onOpenSettings} />

      {/* Main split view */}
      <div className="flex-1 min-h-0 flex">
        {/* Left list pane */}
        <div className="w-80 shrink-0 border-r border-line bg-panel overflow-y-auto flex flex-col">
          {state && state.items.length === 0 ? (
            <div className="p-4 space-y-4 text-[12px]">
              <div className="space-y-1">
                <div className="font-medium text-fg">Context Files</div>
                <p className="text-dim text-[11px]">{KIND_DESC.context}</p>
                <div className="flex gap-1.5 pt-1">
                  <button
                    onClick={() => openCreate('context', 'claude')}
                    className="px-2 py-0.5 rounded border border-line bg-raised hover:bg-dim/20 text-[11px]"
                  >
                    + Claude
                  </button>
                  <button
                    onClick={() => openCreate('context', 'gemini')}
                    className="px-2 py-0.5 rounded border border-line bg-raised hover:bg-dim/20 text-[11px]"
                  >
                    + Gemini
                  </button>
                  <button
                    onClick={() => openCreate('context', 'shared')}
                    className="px-2 py-0.5 rounded border border-line bg-raised hover:bg-dim/20 text-[11px]"
                  >
                    + Shared
                  </button>
                </div>
              </div>

              <div className="space-y-1 border-t border-line pt-3">
                <div className="font-medium text-fg">Skills</div>
                <p className="text-dim text-[11px]">{KIND_DESC.skill}</p>
                <div className="flex gap-1.5 pt-1">
                  <button
                    onClick={() => openCreate('skill', 'claude')}
                    className="px-2 py-0.5 rounded border border-line bg-raised hover:bg-dim/20 text-[11px]"
                  >
                    + Claude Skill
                  </button>
                  <button
                    onClick={() => openCreate('skill', 'gemini')}
                    className="px-2 py-0.5 rounded border border-line bg-raised hover:bg-dim/20 text-[11px]"
                  >
                    + Gemini Skill
                  </button>
                </div>
              </div>

              <div className="space-y-1 border-t border-line pt-3">
                <div className="font-medium text-fg">Subagents</div>
                <p className="text-dim text-[11px]">{KIND_DESC.subagent}</p>
                <div className="flex gap-1.5 pt-1">
                  <button
                    onClick={() => openCreate('subagent', 'claude')}
                    className="px-2 py-0.5 rounded border border-line bg-raised hover:bg-dim/20 text-[11px]"
                  >
                    + Claude Subagent
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-line">
              {/* Context Files Section */}
              <div className="p-2 space-y-1">
                <div className="px-2 py-1 flex items-center justify-between text-[11px] font-semibold text-dim uppercase tracking-wider">
                  <span>{KIND_LABEL.context}</span>
                  <span className="text-[10px] lowercase font-normal">{contextItems.length}</span>
                </div>
                {contextItems.length === 0 ? (
                  <div className="px-2 py-1.5 text-[11px] text-dim">
                    <p>{KIND_DESC.context}</p>
                    <button
                      onClick={() => openCreate('context', 'claude')}
                      className="mt-1 text-accent hover:underline text-[11px]"
                    >
                      + Create context file
                    </button>
                  </div>
                ) : (
                  contextItems.map((item) => (
                    <ItemRow
                      key={item.path}
                      item={item}
                      selected={selectedPath === item.path}
                      findings={findingsByFile.get(item.path) ?? []}
                      onClick={() => selectItem(item.path)}
                    />
                  ))
                )}
              </div>

              {/* Skills Section */}
              <div className="p-2 space-y-1">
                <div className="px-2 py-1 flex items-center justify-between text-[11px] font-semibold text-dim uppercase tracking-wider">
                  <span>{KIND_LABEL.skill}</span>
                  <span className="text-[10px] lowercase font-normal">{skillItems.length}</span>
                </div>
                {skillItems.length === 0 ? (
                  <div className="px-2 py-1.5 text-[11px] text-dim">
                    <p>{KIND_DESC.skill}</p>
                    <button
                      onClick={() => openCreate('skill', 'claude')}
                      className="mt-1 text-accent hover:underline text-[11px]"
                    >
                      + Create skill
                    </button>
                  </div>
                ) : (
                  skillItems.map((item) => (
                    <div key={item.path} className="space-y-0.5">
                      <ItemRow
                        item={item}
                        selected={selectedPath === item.path}
                        findings={findingsByFile.get(item.path) ?? []}
                        onClick={() => selectItem(item.path)}
                        expandable
                        extraCount={item.extraFiles?.length ?? 0}
                        isExpanded={expandedSkills.has(item.path)}
                        onToggleExpand={() => toggleSkillExpand(item.path)}
                      />
                      {expandedSkills.has(item.path) && (
                        <div className="ml-5 pl-2 border-l border-line space-y-0.5 text-[11px] text-dim py-0.5">
                          {(item.extraFiles ?? []).map((f) => {
                            const path = `${skillDir(item)}/${f}`
                            return (
                              <div
                                key={f}
                                onClick={() => selectItem(path)}
                                className={`group/file flex items-center gap-1 rounded px-1.5 py-0.5 cursor-pointer ${selectedPath === path ? 'bg-raised text-fg' : 'hover:bg-raised/60 hover:text-fg'}`}
                                title={path}
                              >
                                <span className="truncate flex-1 font-mono">{f}</span>
                                {!item.readOnly && (
                                  <button
                                    type="button"
                                    aria-label={`Delete ${f}`}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      void deleteAuxFile(path)
                                    }}
                                    className="opacity-0 group-hover/file:opacity-100 focus:opacity-100 text-dim hover:text-[#eb5757]"
                                  >
                                    ✕
                                  </button>
                                )}
                              </div>
                            )
                          })}
                          {!item.readOnly && (
                            <button
                              type="button"
                              onClick={() => setFileDialog({ skillDir: skillDir(item), name: '', content: '' })}
                              className="px-1.5 py-0.5 text-accent hover:underline"
                            >
                              + File
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* Subagents Section */}
              <div className="p-2 space-y-1">
                <div className="px-2 py-1 flex items-center justify-between text-[11px] font-semibold text-dim uppercase tracking-wider">
                  <span>{KIND_LABEL.subagent}</span>
                  <span className="text-[10px] lowercase font-normal">{subagentItems.length}</span>
                </div>
                {subagentItems.length === 0 ? (
                  <div className="px-2 py-1.5 text-[11px] text-dim">
                    <p>{KIND_DESC.subagent}</p>
                    <button
                      onClick={() => openCreate('subagent', 'claude')}
                      className="mt-1 text-accent hover:underline text-[11px]"
                    >
                      + Create subagent
                    </button>
                  </div>
                ) : (
                  subagentItems.map((item) => (
                    <ItemRow
                      key={item.path}
                      item={item}
                      selected={selectedPath === item.path}
                      findings={findingsByFile.get(item.path) ?? []}
                      onClick={() => selectItem(item.path)}
                    />
                  ))
                )}
              </div>
            </div>
          )}

          {/* MCP Servers Section */}
          {mcp && (
            <div className="p-2 space-y-1 border-t border-line">
              <div className="px-2 py-1 flex items-center gap-2 text-[11px] font-semibold text-dim uppercase tracking-wider">
                <span className="flex-1">MCP Servers</span>
                {mcp.exists && (
                  <button onClick={() => selectItem(MCP_FILE)} className="normal-case font-normal text-accent hover:underline">
                    Edit JSON
                  </button>
                )}
                {!mcp.error && (
                  <button onClick={() => selectItem(MCP_KEY)} className="normal-case font-normal text-accent hover:underline">
                    + Add
                  </button>
                )}
                <span className="text-[10px] lowercase font-normal">{mcp.servers.length}</span>
              </div>
              {mcpFileFindings.map((f, i) => (
                <button
                  key={i}
                  onClick={() => selectItem(MCP_FILE)}
                  className="w-full text-left rounded-md px-2.5 py-1.5 text-[11px] bg-[#eb5757]/10 text-[#eb5757]"
                  title={f.fix}
                >
                  {f.reason}
                </button>
              ))}
              {!mcp.error && mcp.servers.length === 0 && (
                <div className="px-2 py-1.5 text-[11px] text-dim">
                  <p>MCP servers give agents extra tools and context (databases, docs search, APIs). They live in .mcp.json and are passed to every agent run.</p>
                  <button onClick={() => selectItem(MCP_KEY)} className="mt-1 text-accent hover:underline text-[11px]">
                    + Add MCP server
                  </button>
                </div>
              )}
              {mcp.servers.map((srv) => (
                <McpServerRow
                  key={srv.name}
                  server={srv}
                  selected={selectedPath === `${MCP_KEY}${srv.name}`}
                  findings={mcpFindings(srv.name)}
                  onClick={() => selectItem(`${MCP_KEY}${srv.name}`)}
                  onToggle={(enabled) => toggleServer(srv.name, enabled)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Detail pane */}
        <div className="flex-1 min-w-0 flex flex-col bg-background overflow-hidden">
          {mcpName !== undefined ? (
            mcpName && !selectedServer ? null : (
              <div className="flex-1 overflow-auto p-6">
                <McpServerEditor
                  key={selectedPath}
                  server={selectedServer}
                  findings={mcpName ? mcpFindings(mcpName) : []}
                  onSave={saveServer}
                  onDelete={selectedServer ? () => void deleteServer(selectedServer.name) : undefined}
                  onDirty={setIsDirty}
                />
              </div>
            )
          ) : selectedItem ? (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Item Detail Header */}
              <div className="shrink-0 border-b border-line px-6 py-3 bg-panel flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[13px] font-medium text-fg truncate">{selectedItem.path}</span>
                    {!selectedItem.raw && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-raised border border-line text-dim font-medium">
                        {AGENT_LABEL[selectedItem.agent]}
                      </span>
                    )}
                    {selectedItem.readOnly && (
                      <span className="text-[10px] bg-line px-1.5 py-0.5 rounded text-dim">
                        read-only · outside project
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-dim flex items-center gap-2 mt-0.5">
                    {selectedItem.aux ? (
                      <span>Auxiliary file of skill {state?.items.find((i) => i.path === `${skillDir(selectedItem)}/SKILL.md`)?.name}</span>
                    ) : selectedItem.raw ? (
                      <span>Project MCP servers – must stay valid JSON</span>
                    ) : (
                      <>
                        <span>{formatBytes(selectedItem.size)}</span>
                        <span>·</span>
                        <span>Modified {formatRelative(selectedItem.mtime)}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  {!editing && !selectedItem.readOnly && (
                    <button
                      onClick={() => setEditing(true)}
                      className="px-2.5 py-1 rounded border border-line bg-raised hover:bg-dim/20 text-[12px] text-fg"
                    >
                      Edit
                    </button>
                  )}
                  {!synthetic && (
                    <button
                      onClick={() => openOptimize(selectedItem.path)}
                      className="px-2.5 py-1 rounded border border-line bg-raised hover:bg-dim/20 text-[12px] text-fg"
                    >
                      Optimize with agent
                    </button>
                  )}
                  {!selectedItem.readOnly && selectedItem.kind !== 'context' && (
                    <button
                      onClick={() => handleDelete(selectedItem)}
                      className="px-2.5 py-1 rounded border border-line text-[#eb5757] hover:bg-[#eb5757]/10 text-[12px]"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {/* Spec Kit Managed Banner */}
              {selectedItem.managed && selectedItem.managed.length > 0 && (
                <div className="shrink-0 px-6 py-2 bg-raised border-b border-line text-[12px] text-dim flex items-center gap-2">
                  <span className="text-accent">ℹ</span>
                  <span>
                    Lines {selectedItem.managed.map((m) => `${m.start}–${m.end}`).join(', ')} are managed by Spec Kit
                  </span>
                </div>
              )}

              {/* Findings for Selected File */}
              {selectedFindings.length > 0 && (
                <div className="shrink-0 border-b border-line bg-[#f2994a]/5 px-6 py-2.5 space-y-2">
                  <div className="text-[11px] font-semibold text-[#f2994a] uppercase tracking-wider flex items-center gap-1.5">
                    <span>Health Findings ({selectedFindings.length})</span>
                  </div>
                  <div className="space-y-1.5 max-h-36 overflow-y-auto">
                    {selectedFindings.map((f, i) => (
                      <div
                        key={i}
                        className="rounded border border-line bg-panel p-2 text-[12px] flex items-start gap-2.5"
                      >
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase shrink-0 ${
                            f.severity === 'error'
                              ? 'bg-[#eb5757]/15 text-[#eb5757]'
                              : 'bg-[#f2994a]/15 text-[#f2994a]'
                          }`}
                        >
                          {f.rule}
                        </span>
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="text-fg select-text">
                            {f.line !== undefined && (
                              <span className="text-dim font-mono mr-1.5">Line {f.line}:</span>
                            )}
                            <span>{f.reason}</span>
                          </div>
                          <div className="text-dim text-[11px] select-text">
                            <span className="font-medium text-fg">Fix:</span> {f.fix}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Main Content Area */}
              <div className="flex-1 min-h-0 overflow-auto p-6">
                {editing ? (
                  <MarkdownEditor
                    initial={content ?? ''}
                    external={content ?? undefined}
                    preview={isMarkdown && selectedItem.size <= 1_000_000}
                    onDirty={setIsDirty}
                    onSave={async (text) => {
                      try {
                        await window.api.agentConfig.write(projectId, selectedItem.path, text, false)
                        setEditing(false)
                        setIsDirty(false)
                      } catch (err: unknown) {
                        const msg = cleanError(err)
                        if (msg.startsWith('MARKERS:')) {
                          if (window.confirm('This breaks the Spec Kit section markers. Save anyway?')) {
                            await window.api.agentConfig.write(projectId, selectedItem.path, text, true)
                            setEditing(false)
                            setIsDirty(false)
                          }
                        } else {
                          throw new Error(msg)
                        }
                      }
                    }}
                    onCancel={() => {
                      setEditing(false)
                      setIsDirty(false)
                    }}
                  />
                ) : (
                  <div className="max-w-4xl">
                    {isMarkdown ? (
                      <Markdown text={content ?? ''} />
                    ) : (
                      <pre className="font-mono text-[12px] text-fg whitespace-pre-wrap select-text">{content ?? ''}</pre>
                    )}
                  </div>
                )}
              </div>

              {/* Sync Section (if folders have both CLAUDE.md and GEMINI.md) */}
              {state?.sync && state.sync.length > 0 && (
                <div className="shrink-0 border-t border-line bg-panel p-4 space-y-3">
                  <div className="text-[12px] font-semibold text-fg">Agent Synchronization</div>
                  <div className="space-y-2">
                    {state.sync.map((diff) => {
                      const inSync = diff.drift.length === 0 && diff.conflicts.length === 0
                      return (
                        <div
                          key={diff.dir}
                          className="rounded-md border border-line bg-raised p-3 text-[12px] space-y-2"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-[11px] text-fg font-medium">
                              {diff.dir ? `${diff.dir}/` : 'Root directory (/) '}
                            </span>
                            {inSync ? (
                              <span className="text-[#4cb782] text-[11px] font-medium">✓ In sync</span>
                            ) : (
                              <span className="text-[#f2994a] text-[11px] font-medium">Drift / conflicts detected</span>
                            )}
                          </div>

                          {!inSync && (
                            <div className="space-y-1.5 text-[11px]">
                              {diff.drift.length > 0 && (
                                <div>
                                  <span className="text-dim font-medium">Drift (only in one agent): </span>
                                  <span className="text-fg">
                                    {diff.drift.map((d) => `"${d.heading}" (${d.only})`).join(', ')}
                                  </span>
                                </div>
                              )}
                              {diff.conflicts.length > 0 && (
                                <div>
                                  <span className="text-[#eb5757] font-medium">Conflicts (different text): </span>
                                  <span className="text-fg">
                                    {diff.conflicts
                                      .map((c) => `"${c.heading}" (CLAUDE:${c.claudeLine}, GEMINI:${c.geminiLine})`)
                                      .join(', ')}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}

                          {diff.shared.length > 0 && (
                            <div className="pt-1 flex items-center justify-between border-t border-line">
                              <span className="text-dim text-[11px]">
                                {diff.shared.length} identical {diff.shared.length === 1 ? 'section' : 'sections'} can be shared
                              </span>
                              <button
                                onClick={() => handleShare(diff)}
                                className="px-2 py-1 rounded bg-accent text-white text-[11px] hover:opacity-90"
                              >
                                Use one shared file
                              </button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-dim text-[13px]">
              Select a file to view and edit its configuration.
            </div>
          )}
        </div>
      </div>

      {/* Create Modal Dialog */}
      {createDialog.open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md rounded-lg bg-panel border border-line shadow-2xl p-5 space-y-4">
            <h2 className="font-semibold text-fg text-sm">
              New {KIND_LABEL[createDialog.kind].slice(0, -1)} ({AGENT_LABEL[createDialog.agent]})
            </h2>
            {createDialog.error && (
              <div className="text-[#eb5757] text-[12px] bg-[#eb5757]/10 p-2 rounded">
                {createDialog.error}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void handleCreate()
              }}
              className="space-y-3"
            >
              {createDialog.kind !== 'context' && (
                <div>
                  <label className="block text-[11px] font-medium text-dim mb-1">Name</label>
                  <input
                    autoFocus
                    required
                    value={createDialog.name}
                    onChange={(e) => setCreateDialog((d) => ({ ...d, name: e.target.value }))}
                    placeholder="e.g. code-review"
                    className="w-full rounded bg-raised border border-line px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent"
                  />
                </div>
              )}
              <div>
                <label className="block text-[11px] font-medium text-dim mb-1">Description</label>
                <input
                  value={createDialog.description}
                  onChange={(e) => setCreateDialog((d) => ({ ...d, description: e.target.value }))}
                  placeholder="One-line description of what this does"
                  className="w-full rounded bg-raised border border-line px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setCreateDialog((d) => ({ ...d, open: false }))}
                  className="px-3 py-1.5 rounded border border-line text-dim hover:text-fg text-[12px]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded bg-accent text-white text-[12px] font-medium hover:opacity-90"
                >
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New auxiliary skill file */}
      {fileDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void handleCreateFile()
            }}
            className="w-full max-w-md rounded-lg bg-panel border border-line shadow-2xl p-5 space-y-3"
          >
            <h2 className="font-semibold text-fg text-sm">New file in {fileDialog.skillDir}</h2>
            {fileDialog.error && <div className="text-[#eb5757] text-[12px] bg-[#eb5757]/10 p-2 rounded">{fileDialog.error}</div>}
            <label className="block">
              <span className="block text-[11px] font-medium text-dim mb-1">File name (sub-folders allowed)</span>
              <input
                autoFocus
                required
                value={fileDialog.name}
                onChange={(e) => setFileDialog((d) => d && { ...d, name: e.target.value })}
                placeholder="e.g. helper.sh or templates/story.md"
                className="w-full rounded bg-raised border border-line px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent font-mono"
              />
            </label>
            <label className="block">
              <span className="block text-[11px] font-medium text-dim mb-1">Content (optional)</span>
              <textarea
                rows={5}
                value={fileDialog.content}
                onChange={(e) => setFileDialog((d) => d && { ...d, content: e.target.value })}
                className="w-full resize-y rounded bg-raised border border-line px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent font-mono"
              />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setFileDialog(null)} className="px-3 py-1.5 rounded border border-line text-dim hover:text-fg text-[12px]">
                Cancel
              </button>
              <button type="submit" className="px-3 py-1.5 rounded bg-accent text-white text-[12px] font-medium hover:opacity-90">
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Optimize Modal Dialog */}
      {optimizeDialog.open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-lg rounded-lg bg-panel border border-line shadow-2xl p-5 space-y-4">
            <h2 className="font-semibold text-fg text-sm">
              {optimizeDialog.target ? `Optimize ${optimizeDialog.target}` : 'Optimize agent configuration'}
            </h2>
            {optimizeDialog.error && (
              <div className="text-[#eb5757] text-[12px] bg-[#eb5757]/10 p-2 rounded">
                {optimizeDialog.error}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void handleOptimize()
              }}
              className="space-y-3"
            >
              <div>
                <label className="block text-[11px] font-medium text-dim mb-1">Agent</label>
                {agents.length === 0 ? (
                  <div className="text-[12px] text-[#eb5757] bg-[#eb5757]/10 p-2 rounded flex items-center justify-between">
                    <span>No agents configured.</span>
                    <button
                      type="button"
                      onClick={() => {
                        setOptimizeDialog((d) => ({ ...d, open: false }))
                        onOpenSettings?.()
                      }}
                      className="text-accent underline ml-2"
                    >
                      Configure an agent in Settings
                    </button>
                  </div>
                ) : (
                  <select
                    value={optimizeDialog.agentId}
                    disabled={!!projectAgentId}
                    title={projectAgentId ? 'The project agent runs this – change it in the Project agent bar' : undefined}
                    onChange={(e) => setOptimizeDialog((d) => ({ ...d, agentId: e.target.value }))}
                    className="w-full rounded bg-raised border border-line px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent"
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.id})
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label className="block text-[11px] font-medium text-dim mb-1">Instructions (optional)</label>
                <textarea
                  rows={3}
                  value={optimizeDialog.instructions}
                  onChange={(e) => setOptimizeDialog((d) => ({ ...d, instructions: e.target.value }))}
                  placeholder="e.g. shorten it, keep only commands"
                  className="w-full resize-none rounded bg-raised border border-line px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOptimizeDialog((d) => ({ ...d, open: false }))}
                  className="px-3 py-1.5 rounded border border-line text-dim hover:text-fg text-[12px]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={agents.length === 0}
                  className="px-3 py-1.5 rounded bg-accent text-white text-[12px] font-medium hover:opacity-90 disabled:opacity-40"
                >
                  Start optimize run
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

function ItemRow(props: {
  item: ConfigItem
  selected: boolean
  findings: Finding[]
  onClick: () => void
  expandable?: boolean
  extraCount?: number
  isExpanded?: boolean
  onToggleExpand?: () => void
}): React.JSX.Element {
  const { item, selected, findings, onClick, expandable, extraCount = 0, isExpanded, onToggleExpand } = props
  const hasErrors = findings.some((f) => f.severity === 'error')

  return (
    <div
      onClick={onClick}
      className={`group rounded-md px-2.5 py-2 cursor-pointer transition-colors text-left flex items-start gap-2 ${
        selected ? 'bg-raised text-fg' : 'hover:bg-raised/60 text-dim hover:text-fg'
      }`}
    >
      {expandable && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand?.()
          }}
          className="text-dim hover:text-fg text-[10px] mt-0.5"
          title={extraCount ? `${extraCount} more file(s)` : 'Files of this skill'}
          aria-label="Toggle skill files"
        >
          {isExpanded ? '▼' : '▶'}
        </button>
      )}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-fg text-[12px] truncate">{item.name}</span>
          <span className="text-[10px] px-1 py-0.2 rounded bg-dim/15 text-dim font-medium uppercase shrink-0">
            {item.agent}
          </span>
          {item.readOnly && (
            <span className="text-[9px] bg-line px-1 rounded text-dim shrink-0">ro</span>
          )}
        </div>
        {item.description && (
          <p className="text-[11px] text-dim truncate leading-snug">{item.description}</p>
        )}
        <div className="flex items-center gap-2 text-[10px] text-dim pt-0.5">
          <span>{formatBytes(item.size)}</span>
          <span>·</span>
          <span>{formatRelative(item.mtime)}</span>
        </div>
      </div>
      {findings.length > 0 && (
        <span
          className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
            hasErrors ? 'bg-[#eb5757]/15 text-[#eb5757]' : 'bg-[#f2994a]/15 text-[#f2994a]'
          }`}
          title={`${findings.length} issue(s)`}
        >
          {findings.length}
        </span>
      )}
    </div>
  )
}
