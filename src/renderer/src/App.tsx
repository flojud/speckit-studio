import { useCallback, useEffect, useState } from 'react'
import type { AgentConfig, OnboardingGuideMode, OnboardingPreferences, Project, ProjectContextMenu, ProjectSnapshot, RemoveProjectState, Run, StepActionTarget } from '../../shared/types'
import { RunPanel } from './components/RunPanel'
import { Palette, type PaletteItem } from './components/Palette'
import { RemoveProjectDialog } from './components/RemoveProjectDialog'
import { OnboardingModal } from './components/OnboardingModal'
import { Board, NewSpecDialog } from './views/Board'
import { Dashboard } from './views/Dashboard'
import { WorkItemDetail, WorkItems } from './views/WorkItems'
import { NewWorkItemDialog } from './components/NewWorkItemDialog'
import { SpecDetail, ACTIONS } from './views/SpecDetail'
import { Constitution } from './views/Constitution'
import { Roadmap } from './views/Roadmap'
import { Wiki } from './views/Wiki'
import { Settings } from './views/Settings'
import { Runs } from './views/Runs'
import { AgentConfig as AgentConfigView } from './views/AgentConfig'
import { InitPanel } from './components/InitPanel'
import { resolvePage } from '../../shared/wiki'
import { getUnreadSteps, ONBOARDING_STEPS, shouldAutoOpenOnboarding } from '../../shared/onboarding'

type View =
  | { kind: 'dashboard' }
  | { kind: 'board' }
  | { kind: 'workItems' }
  | { kind: 'workItem'; key: string }
  | { kind: 'roadmap' }
  | { kind: 'spec'; key: string }
  | { kind: 'constitution' }
  | { kind: 'wiki'; page?: string }
  | { kind: 'agentConfig' }
  | { kind: 'settings' }
  | { kind: 'runs' }
type Attempt = { specKey: string | null; command: string; args: string; worktree?: boolean }
type RunOpts = { force?: boolean; worktree?: boolean }

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))

export default function App(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<number>()
  const [snap, setSnap] = useState<ProjectSnapshot>()
  const [view, setView] = useState<View>({ kind: 'dashboard' })
  const [rev, setRev] = useState(0)
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [agentId, setAgentId] = useState(() => localStorage.getItem('agent') ?? 'claude')
  const [run, setRun] = useState<Run>()
  const [error, setError] = useState<{ message: string; retry?: Attempt }>()
  const [palette, setPalette] = useState(false)
  const [newSpec, setNewSpec] = useState(false)
  const [newWorkItem, setNewWorkItem] = useState(false)
  const [epicFilter, setEpicFilter] = useState<number | 'all'>('all')
  // undefined until loaded; null = never finished or skipped the guide
  const [onboarding, setOnboarding] = useState<OnboardingPreferences | null>()
  const [appVersion, setAppVersion] = useState('')
  const [guide, setGuide] = useState<OnboardingGuideMode>()

  useEffect(() => {
    window.api.listAgents().then(setAgents)
  }, [])
  useEffect(() => {
    localStorage.setItem('agent', agentId)
  }, [agentId])

  /** Starts a Spec Kit command; specKey null = project-level (e.g. specify). A blocked implement offers "Run anyway". */
  async function startRun(specKey: string | null, command: string, args = '', opts: RunOpts = {}): Promise<void> {
    if (projectId === undefined) return
    setError(undefined)
    try {
      await openRun(await window.api.startRun(projectId, specKey, agentId, command, args, opts))
    } catch (e) {
      const message = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      setError(message.startsWith('BLOCKED: ') ? { message: message.slice(9), retry: { specKey, command, args, worktree: opts.worktree } } : { message })
    }
  }

  async function openRun(id: number): Promise<void> {
    if (projectId !== undefined) setRun((await window.api.listRuns(projectId)).find((r) => r.id === id))
  }

  useEffect(() => {
    Promise.all([window.api.listProjects(), window.api.settings.get<OnboardingPreferences>('onboarding'), window.api.appVersion()]).then(([ps, prefs, version]) => {
      setProjects(ps)
      setProjectId((id) => id ?? ps[0]?.id)
      setOnboarding(prefs)
      setAppVersion(version)
      if (shouldAutoOpenOnboarding({ prefs, projectCount: ps.length })) setGuide('all')
    })
  }, [])

  const load = useCallback((id: number) => window.api.snapshot(id).then(setSnap), [])

  useEffect(() => {
    setSnap(undefined)
    setRun(undefined)
    setEpicFilter('all')
    setView({ kind: 'dashboard' })
    if (projectId !== undefined) load(projectId)
  }, [projectId, load])

  useEffect(() => {
    const off = window.api.onChanged((id) => {
      if (id !== projectId) return
      load(id)
      setRev((r) => r + 1)
    })
    // Some results live only in the app DB (e.g. analysis reports), so also refresh when a run changes status.
    const offRun = window.api.onRunEvent((_id, _seq, e) => {
      if (e.type === 'status' && projectId !== undefined) load(projectId)
    })
    return () => (off(), offRun())
  }, [projectId, load])

  async function add(): Promise<void> {
    const p = await window.api.addProject()
    if (!p) return
    setProjects(await window.api.listProjects())
    setProjectId(p.id)
  }

  const [removeState, setRemoveState] = useState<RemoveProjectState>()
  const [contextMenu, setContextMenu] = useState<ProjectContextMenu>()

  useEffect(() => {
    if (!contextMenu) return
    const onDismiss = (): void => setContextMenu(undefined)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setContextMenu(undefined)
    }
    window.addEventListener('click', onDismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', onDismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  async function requestRemove(target: Project): Promise<void> {
    const hasActive = await window.api.hasActiveRun(target.id)
    setRemoveState({ project: target, hasActiveRun: hasActive })
  }

  async function removeProject(target: Project): Promise<void> {
    const idx = projects.findIndex((p) => p.id === target.id)
    await window.api.removeProject(target.id)
    const remaining = projects.filter((p) => p.id !== target.id)
    setProjects(remaining)
    if (projectId === target.id) {
      if (remaining.length === 0) {
        setProjectId(undefined)
      } else {
        const nextIdx = idx < remaining.length ? idx : remaining.length - 1
        setProjectId(remaining[nextIdx].id)
      }
    }
    if (run && run.projectId === target.id) setRun(undefined)
    setRemoveState(undefined)
  }

  /** Persists the guide state on finish, skip/close or a step action; quitting mid-guide writes nothing. */
  function closeGuide(completed: boolean): void {
    const prefs: OnboardingPreferences = {
      completed: completed || !!onboarding?.completed,
      dismissed: !completed,
      lastSeenVersion: appVersion,
      completedAt: new Date().toISOString()
    }
    setOnboarding(prefs)
    setGuide(undefined)
    void window.api.settings.set('onboarding', prefs)
  }

  function guideAction(target: StepActionTarget): void {
    closeGuide(false)
    if (target === 'palette') setPalette(true)
    else setView({ kind: target })
  }

  const unread = onboarding === undefined ? [] : getUnreadSteps(ONBOARDING_STEPS, onboarding?.lastSeenVersion)
  const guideSteps = guide === 'whats-new' ? unread : ONBOARDING_STEPS

  const project = projects.find((p) => p.id === projectId)
  const ready = !!(project && snap?.initialized)
  const spec = view.kind === 'spec' ? snap?.specs.find((s) => s.key === view.key) : undefined
  const workItem = view.kind === 'workItem' ? snap?.workItems.find((w) => w.key === view.key) : undefined
  /** Opens a wiki page by file name or by wikilink name; unknown names are created. */
  async function openWiki(fileOrName: string): Promise<void> {
    if (!snap || projectId === undefined) return
    const page = snap.wiki.find((p) => p.file === fileOrName) ?? resolvePage(snap.wiki, fileOrName)
    if (page) return setView({ kind: 'wiki', page: page.file })
    // Created page may not be in the snapshot yet (watcher reloads it shortly).
    setView({ kind: 'wiki', page: fileOrName.endsWith('.md') ? fileOrName : await window.api.wiki.create(projectId, fileOrName) })
  }

  // Global shortcuts: ⌘K palette, C new spec, W new work item, G D / G B dashboard / board, Esc closes the topmost layer.
  const dialog = newSpec || newWorkItem
  useEffect(() => {
    let g = false
    const onKey = (e: KeyboardEvent): void => {
      const plain = !isTyping(e.target) && !palette && !dialog && !e.metaKey && !e.ctrlKey && !e.altKey && ready
      const prefixed = g
      g = false
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPalette((p) => !p)
      } else if (e.key === 'Escape' && !palette && !dialog) setRun(undefined)
      else if (plain && prefixed && (e.key === 'd' || e.key === 'b')) setView({ kind: e.key === 'd' ? 'dashboard' : 'board' })
      else if (plain && e.key === 'g') g = true
      else if (plain && e.key === 'c') (e.preventDefault(), setNewSpec(true))
      else if (plain && e.key === 'w') (e.preventDefault(), setNewWorkItem(true))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [palette, dialog, ready])

  const items: PaletteItem[] = [
    ...(ready
      ? [
          { id: 'new', label: 'New spec', hint: 'C', run: () => setNewSpec(true) },
          { id: 'new-wi', label: 'New work item', hint: 'W', run: () => setNewWorkItem(true) },
          { id: 'v-dashboard', label: 'Go to Dashboard', hint: 'G D', run: () => setView({ kind: 'dashboard' }) },
          { id: 'v-board', label: 'Go to Board', hint: 'G B', run: () => setView({ kind: 'board' }) },
          { id: 'v-workItems', label: 'Go to Work Items', run: () => setView({ kind: 'workItems' }) },
          { id: 'v-roadmap', label: 'Go to Roadmap', run: () => setView({ kind: 'roadmap' }) },
          { id: 'v-const', label: 'Go to Constitution', run: () => setView({ kind: 'constitution' }) },
          { id: 'v-wiki', label: 'Go to Wiki', run: () => setView({ kind: 'wiki' }) },
          { id: 'v-agentConfig', label: 'Go to Agent Config', run: () => setView({ kind: 'agentConfig' }) },
          { id: 'v-runs', label: 'Go to Runs', run: () => setView({ kind: 'runs' }) },
          ...snap!.wiki.map((p) => ({ id: `w-${p.file}`, label: `Wiki: ${p.title}`, run: () => setView({ kind: 'wiki', page: p.file }) })),
          ...(spec ? ACTIONS.map((a) => ({ id: `run-${a}`, label: `Run ${a} on ${spec.number} ${spec.title}`, run: () => startRun(spec.key, a) })) : []),
          ...snap!.specs.map((s) => ({ id: `spec-${s.key}`, label: `Open ${s.number} ${s.title}`, hint: s.phase, run: () => setView({ kind: 'spec', key: s.key }) })),
          ...snap!.workItems.map((w) => ({ id: `wi-${w.key}`, label: `Open ${w.title}`, hint: w.status, run: () => setView({ kind: 'workItem', key: w.key }) }))
        ]
      : []),
    ...projects.filter((p) => p.id !== projectId).map((p) => ({ id: `p-${p.id}`, label: `Switch to project ${p.name}`, run: () => setProjectId(p.id) })),
    ...agents.filter((a) => a.id !== agentId).map((a) => ({ id: `a-${a.id}`, label: `Use agent ${a.name}`, run: () => setAgentId(a.id) })),
    ...(project ? [{ id: 'remove-project', label: `Remove project ${project.name}`, run: () => void requestRemove(project) }] : []),
    { id: 'add', label: 'Add project…', run: add },
    { id: 'settings', label: 'Open Settings (agents)', run: () => setView({ kind: 'settings' }) },
    { id: 'onboarding', label: 'Restart Onboarding Guide', run: () => setGuide('all') }
  ]

  const crumb = spec
    ? `${spec.number} ${spec.title}`
    : workItem
      ? `${workItem.key.match(/^WI-\d+/i)?.[0] ?? workItem.key} ${workItem.title}`
      : (
          {
            dashboard: 'Dashboard',
            board: 'Board',
            workItems: 'Work Items',
            roadmap: 'Roadmap',
            constitution: 'Constitution',
            wiki: 'Wiki',
            agentConfig: 'Agent Config',
            settings: 'Settings',
            runs: 'Runs'
          } as Record<string, string>
        )[view.kind]

  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 bg-panel border-r border-line flex flex-col">
        <div className="drag h-11 shrink-0" />
        <div className="px-3 pb-1 text-[11px] font-medium text-dim uppercase tracking-wide">Projects</div>
        <nav className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {projects.map((p) => (
            <div key={p.id}>
              <SideItem
                active={p.id === projectId && view.kind === 'dashboard'}
                onClick={() => (p.id === projectId ? setView({ kind: 'dashboard' }) : setProjectId(p.id))}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setContextMenu({ x: e.clientX, y: e.clientY, project: p })
                }}
                onRemove={() => void requestRemove(p)}
              >
                {p.name}
              </SideItem>
              {p.id === projectId && snap?.initialized && (
                <div className="ml-3 mt-0.5 space-y-0.5">
                  <SideItem active={view.kind === 'dashboard'} onClick={() => setView({ kind: 'dashboard' })}>
                    Dashboard
                  </SideItem>
                  <SideItem active={view.kind === 'board' || view.kind === 'spec'} onClick={() => setView({ kind: 'board' })}>
                    Board
                  </SideItem>
                  <SideItem active={view.kind === 'workItems' || view.kind === 'workItem'} onClick={() => setView({ kind: 'workItems' })}>
                    Work Items
                  </SideItem>
                  <SideItem active={view.kind === 'roadmap'} onClick={() => setView({ kind: 'roadmap' })}>
                    Roadmap
                  </SideItem>
                  <SideItem active={view.kind === 'constitution'} onClick={() => setView({ kind: 'constitution' })}>
                    Constitution
                  </SideItem>
                  <SideItem active={view.kind === 'wiki'} onClick={() => setView({ kind: 'wiki' })}>
                    Wiki
                  </SideItem>
                  <SideItem active={view.kind === 'agentConfig'} onClick={() => setView({ kind: 'agentConfig' })}>
                    Agent Config
                  </SideItem>
                  <SideItem active={view.kind === 'runs'} onClick={() => setView({ kind: 'runs' })}>
                    Runs
                  </SideItem>
                </div>
              )}
            </div>
          ))}
        </nav>
        {unread.length > 0 && (
          <button onClick={() => setGuide(onboarding ? 'whats-new' : 'all')} className="mx-2 mb-1 rounded-md px-2 py-1.5 text-left text-accent hover:bg-raised">
            ✨ {onboarding ? `What's New (${unread.length})` : 'Take the tour'}
          </button>
        )}
        {appVersion && <div className="px-4 pb-0.5 text-[11px] font-mono text-dim/60 select-text">v{appVersion}</div>}
        <button onClick={() => setView({ kind: 'settings' })} className={`mx-2 rounded-md px-2 py-1.5 text-left hover:bg-raised hover:text-fg ${view.kind === 'settings' ? 'bg-raised text-fg' : 'text-dim'}`}>
          Settings
        </button>
        <button onClick={() => setPalette(true)} className="mx-2 rounded-md px-2 py-1.5 text-left text-dim hover:bg-raised hover:text-fg flex">
          Command palette <span className="ml-auto text-[11px]">⌘K</span>
        </button>
        <button onClick={add} className="m-2 mt-0.5 rounded-md px-2 py-1.5 text-left text-dim hover:bg-raised hover:text-fg">
          + Add project
        </button>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        <header className="drag h-11 shrink-0 border-b border-line flex items-center px-4 gap-2 text-dim">
          {project && (
            <>
              <button className="no-drag hover:text-fg" onClick={() => setView({ kind: 'dashboard' })}>
                {project.name}
              </button>
              {crumb && <span>/ <span className="text-fg">{crumb}</span></span>}
              <span className="ml-auto flex items-center gap-3 text-[11px]">
                {snap?.integration && <span>{snap.integration} · {snap.commandPrefix}*</span>}
                <select
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  className="no-drag bg-raised border border-line rounded px-1.5 py-0.5 text-fg outline-none"
                  title="Agent for new runs"
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </span>
            </>
          )}
        </header>
        {error && (
          <div className="flex items-center gap-3 bg-[#eb575722] text-[#eb5757] px-4 py-2">
            <span className="flex-1 select-text">{error.message}</span>
            {error.retry && (
              <button className="rounded-md border border-[#eb5757] px-2 py-0.5" onClick={() => startRun(error.retry!.specKey, error.retry!.command, error.retry!.args, { force: true, worktree: error.retry!.worktree })}>
                Run anyway
              </button>
            )}
            <button onClick={() => setError(undefined)}>✕</button>
          </div>
        )}
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 overflow-auto">
            {view.kind === 'settings' ? (
              <Settings onAgentsChanged={() => window.api.listAgents().then(setAgents)} onRestartGuide={() => setGuide('all')} />
            ) : !project ? (
              <Empty>Add a local repository initialized with Spec Kit.</Empty>
            ) : !snap ? null : snap.missing ? (
              <Empty>Folder not found: {snap.path}</Empty>
            ) : !snap.initialized ? (
              <InitPanel projectId={project.id} path={snap.path} />
            ) : view.kind === 'dashboard' ? (
              <Dashboard
                projectId={project.id}
                snap={snap}
                rev={rev}
                onNewSpec={() => setNewSpec(true)}
                onNewWorkItem={() => setNewWorkItem(true)}
                onOpenBoard={() => setView({ kind: 'board' })}
                onOpenRoadmap={() => setView({ kind: 'roadmap' })}
                onOpenRuns={() => setView({ kind: 'runs' })}
                onOpenRun={setRun}
              />
            ) : view.kind === 'workItems' ? (
              <WorkItems snap={snap} onOpen={(key) => setView({ kind: 'workItem', key })} onNew={() => setNewWorkItem(true)} />
            ) : view.kind === 'workItem' ? (
              workItem ? (
                <WorkItemDetail
                  key={workItem.key}
                  projectId={project.id}
                  snap={snap}
                  item={workItem}
                  rev={rev}
                  onRunAgent={async (prompt) => openRun(await window.api.workItems.startRun(project.id, workItem.key, agentId, prompt))}
                  onOpenRun={setRun}
                  onClose={() => setView({ kind: 'workItems' })}
                />
              ) : (
                <Empty>Work item not found: {view.key}</Empty>
              )
            ) : view.kind === 'constitution' ? (
              <Constitution
                projectId={project.id}
                snap={snap}
                rev={rev}
                onAmend={(text) => startRun(null, 'constitution', text)}
                onOpenSpec={(key) => setView({ kind: 'spec', key })}
              />
            ) : view.kind === 'runs' ? (
              <Runs projectId={project.id} rev={rev} onOpen={setRun} />
            ) : view.kind === 'wiki' ? (
              <Wiki
                projectId={project.id}
                snap={snap}
                rev={rev}
                page={view.page}
                onPage={(page) => setView({ kind: 'wiki', page })}
                onOpenSpec={(key) => setView({ kind: 'spec', key })}
              />
            ) : view.kind === 'agentConfig' ? (
              <AgentConfigView
                projectId={project.id}
                rev={rev}
                onOpenRun={async (runId) => {
                  const runs = await window.api.listRuns(project.id)
                  const match = runs.find((r) => r.id === runId)
                  if (match) setRun(match)
                }}
                onOpenSettings={() => setView({ kind: 'settings' })}
              />
            ) : view.kind === 'roadmap' ? (
              <Roadmap key={project.id} projectId={project.id} snap={snap} onOpen={(key) => setView({ kind: 'spec', key })} />
            ) : spec ? (
              <SpecDetail projectId={project.id} snap={snap} spec={spec} rev={rev} onRun={(cmd, args, opts) => startRun(spec.key, cmd, args, opts)} onOpenRun={setRun} onOpenWiki={openWiki} onClose={() => setView({ kind: 'board' })} />
            ) : (
              <Board
                snap={snap}
                epicFilter={epicFilter}
                onEpicFilter={setEpicFilter}
                onOpen={(key) => setView({ kind: 'spec', key })}
                onOpenWorkItem={(key) => setView({ kind: 'workItem', key })}
                onNewSpec={() => setNewSpec(true)}
                onNewWorkItem={() => setNewWorkItem(true)}
                onRun={(key, cmd) => startRun(key, cmd)}
              />
            )}
          </div>
          {run && run.projectId === projectId && <RunPanel key={run.id} run={run} onClose={() => setRun(undefined)} />}
        </div>
      </main>

      {newSpec && projectId !== undefined && (
        <NewSpecDialog
          onCancel={() => setNewSpec(false)}
          onSubmit={(d) => (setNewSpec(false), startRun(null, 'specify', d))}
          onSaveDraft={async (title, description) => void (await window.api.drafts.create(projectId, title, description))}
        />
      )}
      {newWorkItem && projectId !== undefined && (
        <NewWorkItemDialog
          onCancel={() => setNewWorkItem(false)}
          onSubmit={async (title, category, content) => {
            const key = await window.api.workItems.create(projectId, title, category, content)
            setNewWorkItem(false)
            await load(projectId)
            setView({ kind: 'workItem', key })
          }}
        />
      )}
      {removeState && (
        <RemoveProjectDialog
          project={removeState.project}
          hasActiveRun={removeState.hasActiveRun}
          onCancel={() => setRemoveState(undefined)}
          onConfirm={() => void removeProject(removeState.project)}
        />
      )}
      {contextMenu && (
        <div
          className="fixed z-40 bg-panel border border-line rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              const target = contextMenu.project
              setContextMenu(undefined)
              void requestRemove(target)
            }}
            className="w-full text-left px-3 py-1.5 text-[13px] text-[#eb5757] hover:bg-raised transition-colors"
          >
            Remove Project…
          </button>
        </div>
      )}
      {palette && <Palette items={items} onClose={() => setPalette(false)} />}
      {guide && guideSteps.length > 0 && (
        <OnboardingModal
          key={guide}
          steps={guideSteps}
          onViewAll={guide === 'whats-new' ? () => setGuide('all') : undefined}
          onClose={closeGuide}
          onAction={guideAction}
        />
      )}
    </div>
  )
}

function SideItem(props: {
  active: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  onRemove?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={`group relative flex items-center rounded-md text-left transition-colors ${
        props.active ? 'bg-raised text-fg' : 'text-dim hover:bg-raised hover:text-fg'
      }`}
      onContextMenu={props.onContextMenu}
    >
      <button
        type="button"
        onClick={props.onClick}
        className="flex-1 min-w-0 truncate px-2 py-1 text-left"
      >
        {props.children}
      </button>
      {props.onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            props.onRemove!()
          }}
          title="Remove project"
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 mr-1 text-dim hover:text-[#eb5757] rounded"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
            <path d="M5.5 2.5A.5.5 0 0 1 6 2h4a.5.5 0 0 1 .5.5V3h3a.5.5 0 0 1 0 1h-.54l-.79 9.07A1.5 1.5 0 0 1 10.68 14.5H5.32a1.5 1.5 0 0 1-1.49-1.43L3.04 4H2.5a.5.5 0 0 1 0-1h3v-.5zm1 .5h3v-.5h-3V3zm-2.45 1 .77 8.93a.5.5 0 0 0 .5.47h5.36a.5.5 0 0 0 .5-.47L11.95 4H4.05z" />
          </svg>
        </button>
      )}
    </div>
  )
}

const Empty = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <div className="h-full grid place-items-center text-dim">
    <p>{children}</p>
  </div>
)
