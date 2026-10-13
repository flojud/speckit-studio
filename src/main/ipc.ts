import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { applyPm } from '../shared/pm'
import { workItemPrompt } from '../shared/runs'
import {
  WORK_ITEM_CATEGORIES,
  WORK_ITEM_STATUSES,
  type AgentConfig,
  type ConfigAgent,
  type ConfigKind,
  type GlobalAgentDefaults,
  type McpServerConfig,
  type PhaseConfig,
  type ProjectAgentInfo,
  type ProjectAgentPreferences,
  type Spec,
  type WorkItem
} from '../shared/types'
import { slugify } from '../shared/wiki'
import * as db from './db'
import { addProject, getAnalysisMarkdown, getProject, getRun, latestAnalyses, listAgents, listProjects, listRunEvents, listRuns, removeProject } from './db'
import { baselineFor, configState, createConfig, createSkillFile, deleteConfig, deleteSkillFile, fileChanges, optimizePrompt, readMarkers, shareConfig, writeConfig } from './agentconfig'
import { applyGit, createPr, gitInfo, mergeSpec, removeWorktree, specRefNames, WORKTREES, type GitInfo } from './git'
import { deleteMcpServer, saveMcpServer, toggleMcpServer } from './mcp'
import { installAgent } from './registry'
import { probeAgent } from './runner'
import { checkTools, onPath, specifyInit } from './env'
import { answerPermission, cancelProjectRuns, cancelRun, finishRun, hasActiveRun, replyRun, startRun, WORK_ITEM_COMMAND, type StartOptions } from './runs'
import {
  backlinks,
  CONSTITUTION,
  draftMarkdown,
  listWiki,
  nextSpecPrefix,
  nextWorkItemKey,
  numberingScheme,
  parseWorkItem,
  readIntegration,
  readProject,
  readSpec,
  setTaskDone,
  WIKI_DIR,
  WORK_ITEMS_DIR,
  workItemMarkdown,
  writeStudioAgent
} from './speckit'
import { watchProject } from './watcher'

const watchers = new Map<number, () => void>()

const notifyChanged = (id: number): void => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('project:changed', id))

function ensureWatch(id: number, path: string): void {
  if (watchers.has(id)) return
  watchers.set(
    id,
    watchProject(path, () => notifyChanged(id))
  )
}

/** Resolves `rel` inside the project or throws (renderer input is not trusted with paths). */
function inside(id: number, rel: string): string {
  const root = projectPath(id)
  const file = resolve(root, rel)
  if (relative(root, file).startsWith('..')) throw new Error('Path outside project')
  return file
}

/** Folder of spec `key` directly under `specs/` (renderer input: no `..` or nested paths). */
function specDir(id: number, key: string): string {
  const dir = inside(id, `specs/${key}`)
  if (dirname(dir) !== resolve(projectPath(id), 'specs')) throw new Error(`Invalid spec key ${key}`)
  return dir
}

/** File of work item `key` directly under `work-items/` (renderer input: no `..` or nested paths). */
function workItemFile(id: number, key: string): string {
  const file = inside(id, `${WORK_ITEMS_DIR}/${key}.md`)
  if (dirname(file) !== resolve(projectPath(id), WORK_ITEMS_DIR)) throw new Error(`Invalid work item key ${key}`)
  if (!existsSync(file)) throw new Error('Work item not found')
  return file
}

/** Renderer input is not trusted with enum values either. */
function checkWorkItem(w: Pick<WorkItem, 'title' | 'category' | 'status'>): void {
  if (!w.title.trim()) throw new Error('Title is required')
  if (!WORK_ITEM_CATEGORIES.includes(w.category)) throw new Error(`Unknown category ${w.category}`)
  if (!WORK_ITEM_STATUSES.includes(w.status)) throw new Error(`Unknown status ${w.status}`)
}

function projectPath(id: number): string {
  const p = getProject(id)
  if (!p) throw new Error(`Unknown project ${id}`)
  return p.path
}

/** Specs with their worktree copy where one exists – while a spec has a worktree, its files there are the current state. */
function withWorktrees(path: string, snap: ReturnType<typeof readProject>, git: GitInfo): Spec[] {
  return snap.specs.map((s) => {
    const rel = `${WORKTREES}/${s.key}/specs/${s.key}`
    return git.worktrees.includes(s.key) && existsSync(resolve(path, rel)) ? readSpec(path, rel, s.key, snap.constitution?.mtime) : s
  })
}

export function registerIpc(): void {
  ipcMain.handle('projects:list', () => listProjects())

  ipcMain.handle('projects:add', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths[0]) return null
    return addProject(res.filePaths[0])
  })

  ipcMain.handle('projects:hasActiveRun', (_e, id: number) => hasActiveRun(id))

  ipcMain.handle('projects:remove', (_e, id: number) => {
    cancelProjectRuns(id)
    watchers.get(id)?.()
    watchers.delete(id)
    removeProject(id)
  })

  ipcMain.handle('project:snapshot', async (_e, id: number) => {
    const path = projectPath(id)
    ensureWatch(id, path)
    const snap = readProject(path)
    const git = await gitInfo(path)
    snap.specs = withWorktrees(path, snap, git)
    applyGit(snap.specs, git)
    snap.git = git.isRepo ? { defaultBranch: git.defaultBranch } : undefined
    const analyses = new Map(latestAnalyses(id).map(({ specKey, ...a }) => [specKey, a]))
    snap.specs.forEach((s) => (s.analysis = analyses.get(s.key)))
    const data = db.getPm(id)
    applyPm(snap.specs, data, snap.workItems)
    snap.epics = data.epics
    snap.milestones = data.milestones
    return snap
  })

  ipcMain.handle('tasks:toggle', (_e, id: number, specDir: string, taskId: string, done: boolean) => {
    const file = inside(id, `${specDir}/tasks.md`)
    const next = setTaskDone(readFileSync(file, 'utf8'), taskId, done)
    if (next === undefined) throw new Error(`Task ${taskId} not found in tasks.md`)
    writeFileSync(file, next)
  })

  // Writes only what the user edits explicitly: the constitution and wiki pages (constitution principle IV).
  ipcMain.handle('files:write', (_e, id: number, rel: string, content: string) => {
    const root = projectPath(id)
    const file = resolve(root, rel)
    const r = relative(root, file)
    if (r !== CONSTITUTION && !(r.startsWith(`${WIKI_DIR}/`) && r.endsWith('.md') && !r.includes('..'))) throw new Error(`Not writable: ${rel}`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  })

  ipcMain.handle('wiki:create', (_e, id: number, title: string, body = '') => {
    const name = `${slugify(title)}.md`
    const file = resolve(projectPath(id), WIKI_DIR, name)
    if (existsSync(file) || listWiki(projectPath(id)).some((p) => p.title.toLowerCase() === title.trim().toLowerCase()))
      throw new Error(`A wiki page "${title}" already exists`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `# ${title.trim()}\n\n${body}`)
    return name
  })

  // Drafts: specs/<key>/draft.md, written only from what the user types (constitution principle IV).
  // Never touches branches and never commits.
  ipcMain.handle('drafts:create', async (_e, id: number, title: string, description: string) => {
    if (!title.trim()) throw new Error('Title is required')
    const root = projectPath(id)
    const specs = join(root, 'specs')
    mkdirSync(specs, { recursive: true })
    // ponytail: a specify run that picked its number but has no folder/branch yet can collide; count active runs' feature.json if it bites.
    const prefix = nextSpecPrefix([...readdirSync(specs), ...(await specRefNames(root))], numberingScheme(root), new Date())
    const key = `${prefix}-${slugify(title).split('-').slice(0, 4).join('-')}`
    mkdirSync(join(specs, key)) // EEXIST surfaces as an error
    writeFileSync(join(specs, key, 'draft.md'), draftMarkdown(title, description))
    notifyChanged(id)
    return key
  })

  ipcMain.handle('drafts:update', (_e, id: number, key: string, title: string, description: string) => {
    const dir = specDir(id, key)
    if (!existsSync(dir)) throw new Error(`Unknown spec ${key}`)
    if (existsSync(join(dir, 'spec.md'))) throw new Error('Already specified – edit spec.md instead')
    if (!title.trim()) throw new Error('Title is required')
    writeFileSync(join(dir, 'draft.md'), draftMarkdown(title, description))
    notifyChanged(id)
  })

  ipcMain.handle('drafts:delete', (_e, id: number, key: string) => {
    const dir = specDir(id, key)
    if (!existsSync(dir) || readdirSync(dir).join() !== 'draft.md') throw new Error('Only drafts can be deleted')
    rmSync(dir, { recursive: true })
    db.forgetSpec(id, key)
    notifyChanged(id)
  })

  // Work items: work-items/<key>.md, written only from what the user edits (constitution principle IV).
  // The key (= file name) never changes; title edits only touch the frontmatter.
  ipcMain.handle('workItems:create', (_e, id: number, title: string, category: WorkItem['category'], initialContent = '') => {
    const item = { title, category, status: 'draft' as const, body: initialContent }
    checkWorkItem(item)
    const dir = join(projectPath(id), WORK_ITEMS_DIR)
    mkdirSync(dir, { recursive: true })
    const key = nextWorkItemKey(readdirSync(dir), title)
    writeFileSync(join(dir, `${key}.md`), workItemMarkdown(item), { flag: 'wx' }) // never overwrite
    notifyChanged(id)
    return key
  })

  ipcMain.handle('workItems:update', (_e, id: number, key: string, updates: Partial<Pick<WorkItem, 'title' | 'category' | 'status' | 'body'>>) => {
    const file = workItemFile(id, key)
    const current = parseWorkItem(key, readFileSync(file, 'utf8'))
    const next = { title: updates.title ?? current.title, category: updates.category ?? current.category, status: updates.status ?? current.status, body: updates.body ?? current.body }
    checkWorkItem(next)
    writeFileSync(file, workItemMarkdown(next))
    notifyChanged(id)
  })

  ipcMain.handle('workItems:delete', (_e, id: number, key: string) => {
    rmSync(workItemFile(id, key))
    db.forgetWorkItem(id, key)
    notifyChanged(id)
  })

  // Plain-prompt run in the repo root: the agent may edit the item or write wiki pages, all through ACP permissions.
  ipcMain.handle('runs:startWorkItem', (_e, id: number, key: string, agentId: string, request: string) => {
    if (!request.trim()) throw new Error('Prompt is required')
    const item = parseWorkItem(key, readFileSync(workItemFile(id, key), 'utf8'))
    return startRun(id, key, agentId, WORK_ITEM_COMMAND, '', { prompt: workItemPrompt(item, request), worktree: false })
  })

  ipcMain.handle('wiki:backlinks', (_e, id: number, file: string) => {
    const page = listWiki(projectPath(id)).find((p) => p.file === file)
    return page ? backlinks(projectPath(id), page) : []
  })

  /** Points agents at the wiki: appends a short section to CLAUDE.md / AGENTS.md once. */
  ipcMain.handle('wiki:linkAgents', (_e, id: number) => {
    const root = projectPath(id)
    const targets = ['CLAUDE.md', 'AGENTS.md'].filter((f) => existsSync(resolve(root, f)))
    if (!targets.length) targets.push('CLAUDE.md')
    const section = `\n## Project wiki\n\nProject knowledge (decisions, setup, conventions) lives in \`${WIKI_DIR}/\` as Markdown. Read relevant pages before planning or implementing.\n`
    const updated = targets.filter((f) => !(existsSync(resolve(root, f)) && readFileSync(resolve(root, f), 'utf8').includes(`${WIKI_DIR}/`)))
    updated.forEach((f) => appendFileSync(resolve(root, f), section))
    return updated
  })

  ipcMain.handle('analysis:read', (_e, runId: number) => getAnalysisMarkdown(runId))

  // Reads a file inside the project; refuses paths that escape it.
  ipcMain.handle('project:readFile', (_e, id: number, rel: string) => readFile(inside(id, rel), 'utf8').catch(() => null))

  ipcMain.handle('agents:list', () => listAgents())
  ipcMain.handle('runs:list', (_e, projectId: number, specKey?: string) => listRuns(projectId, specKey))
  ipcMain.handle('runs:events', (_e, runId: number) => listRunEvents(runId))
  ipcMain.handle('runs:start', (_e, projectId: number, specKey: string | null, agentId: string, command: string, args: string, opts: StartOptions) =>
    startRun(projectId, specKey, agentId, command, args, opts)
  )

  // Agents & settings
  ipcMain.handle('agents:install', async (_e, registryId: string) => {
    const agent = await installAgent(registryId, app.getPath('userData'))
    db.upsertAgent(agent)
    return agent
  })
  ipcMain.handle('agents:save', (_e, agent: AgentConfig) => db.upsertAgent(agent))
  ipcMain.handle('agents:delete', (_e, agentId: string) => db.deleteAgent(agentId))
  ipcMain.handle('settings:phaseAgents', () => db.getPhaseAgents())
  ipcMain.handle('settings:setPhaseAgents', (_e, map: Record<string, string>) => db.setPhaseAgents(map))
  ipcMain.handle('settings:phaseConfigs', () => db.getPhaseConfigs())
  ipcMain.handle('settings:setPhaseConfigs', (_e, configs: Record<string, PhaseConfig>) => db.setPhaseConfigs(configs))
  ipcMain.handle('settings:globalDefaults', () => db.getGlobalDefaults())
  ipcMain.handle('agents:options', (_e, agentId: string) => db.getAgentOptions(agentId))
  // Starts the agent once (no prompt) on the user's request; the agent may contact its provider to sign in.
  ipcMain.handle('agents:probe', async (_e, agentId: string) => {
    const agent = db.getAgent(agentId)
    if (!agent) throw new Error(`Unknown agent ${agentId}`)
    const options = await probeAgent(agent, app.getPath('userData'))
    db.setAgentOptions(agentId, options)
    return options
  })
  ipcMain.handle('settings:setGlobalDefaults', (_e, defaults: GlobalAgentDefaults) => db.setGlobalDefaults(defaults))
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('settings:get', (_e, key: string) => db.getSetting(key, null))
  ipcMain.handle('settings:set', (_e, key: string, value: unknown) => db.setSetting(key, value))

  // Environment & onboarding
  ipcMain.handle('env:tools', () => checkTools())
  ipcMain.handle('specify:init', async (_e, projectId: number, integration: string) => {
    const result = await specifyInit(projectPath(projectId), integration)
    notifyChanged(projectId)
    return result
  })

  // Git
  ipcMain.handle('git:removeWorktree', async (_e, projectId: number, specKey: string) => {
    await removeWorktree(projectPath(projectId), specKey)
    notifyChanged(projectId)
  })
  ipcMain.handle('git:createPr', async (_e, projectId: number, specKey: string) => {
    const path = projectPath(projectId)
    return createPr(path, specKey, (await gitInfo(path)).base!)
  })
  // Dropping a spec on Done: all tasks ticked → merge its branch into the base branch locally (never pushed).
  ipcMain.handle('git:merge', async (_e, projectId: number, specKey: string) => {
    const path = projectPath(projectId)
    const git = await gitInfo(path)
    const snap = readProject(path)
    const spec = withWorktrees(path, snap, git).find((s) => s.key === specKey)
    if (!git.isRepo || !git.base) throw new Error('Not a git repository.')
    const done = spec?.tasks.filter((t) => t.done).length ?? 0
    if (!spec?.tasks.length || done < spec.tasks.length) throw new Error(`${specKey} has open tasks (${done}/${spec?.tasks.length ?? 0} done) – finish or tick them first.`)
    if (!git.branches.includes(specKey) || git.merged.includes(specKey)) throw new Error(`${specKey} has no unmerged branch – nothing to merge.`)
    await mergeSpec(path, specKey, git.base)
    notifyChanged(projectId)
  })

  // PM mutations: every change notifies the renderer to reload the snapshot.
  const mutate = <A extends unknown[]>(channel: string, fn: (projectId: number, ...args: A) => void): void =>
    void ipcMain.handle(channel, (_e, projectId: number, ...args: A) => {
      fn(projectId, ...args)
      notifyChanged(projectId)
    })
  mutate('pm:epic:create', (p, title: string, goal: string) => db.createEpic(p, title, goal))
  mutate('pm:epic:delete', (_p, id: number) => db.deleteEpic(id))
  mutate('pm:milestone:create', (p, title: string, due: string | null) => db.createMilestone(p, title, due))
  mutate('pm:milestone:delete', (_p, id: number) => db.deleteMilestone(id))
  mutate('pm:milestone:due', (p, id: number, due: string | null) => db.setMilestoneDue(p, id, due))
  mutate('pm:meta:set', (p, specKey: string, field: 'epic' | 'milestone', value: number | null) =>
    db.setSpecMeta(p, specKey, field === 'epic' ? 'epic_id' : 'milestone_id', value)
  )
  mutate('pm:workItemMeta:set', (p, key: string, field: 'epic' | 'milestone', value: number | null) =>
    db.setWorkItemMeta(p, key, field === 'epic' ? 'epic_id' : 'milestone_id', value)
  )
  mutate('pm:dep:add', (p, specKey: string, blockedBy: string) => db.addDependency(p, specKey, blockedBy))
  mutate('pm:dep:remove', (p, specKey: string, blockedBy: string) => db.removeDependency(p, specKey, blockedBy))
  ipcMain.handle('runs:reply', (_e, runId: number, text: string) => replyRun(runId, text))
  ipcMain.handle('runs:answer', (_e, runId: number, requestId: string, optionId: string | null) => answerPermission(runId, requestId, optionId))
  ipcMain.handle('runs:cancel', (_e, runId: number) => cancelRun(runId))
  ipcMain.handle('runs:finish', (_e, runId: number) => finishRun(runId))

  // Agent Config
  ipcMain.handle('agentConfig:list', async (_e, projectId: number) => configState(projectPath(projectId)))
  ipcMain.handle('agentConfig:write', async (_e, projectId: number, path: string, content: string, force = false) => {
    await writeConfig(projectPath(projectId), path, content, force)
    notifyChanged(projectId)
  })
  ipcMain.handle('agentConfig:create', (_e, projectId: number, kind: ConfigKind, agent: ConfigAgent, name: string, description: string) => {
    const p = createConfig(projectPath(projectId), kind, agent, name, description)
    notifyChanged(projectId)
    return p
  })
  ipcMain.handle('agentConfig:delete', async (_e, projectId: number, path: string) => {
    await deleteConfig(projectPath(projectId), path)
    notifyChanged(projectId)
  })
  ipcMain.handle('agentConfig:share', (_e, projectId: number, dir: string) => {
    const res = shareConfig(projectPath(projectId), dir)
    notifyChanged(projectId)
    return res
  })
  ipcMain.handle('agentConfig:optimize', async (_e, projectId: number, agentId: string, path: string | null, instructions: string) => {
    const root = projectPath(projectId)
    const state = await configState(root)
    const targets = path ? [path] : state.items.filter((i) => !i.readOnly).map((i) => i.path)
    const targetSet = new Set(targets)
    const findings = state.findings.filter((f) => targetSet.has(f.file))
    const prompt = optimizePrompt(targets, findings, instructions, readMarkers(root))
    const baseline = baselineFor(root, targets, path === null)
    return startRun(projectId, null, agentId, 'optimize', '', { prompt, baseline })
  })
  ipcMain.handle('skills:createFile', async (_e, projectId: number, skillDir: string, rel: string, content: string) => {
    const p = await createSkillFile(projectPath(projectId), skillDir, rel, content)
    notifyChanged(projectId)
    return p
  })
  ipcMain.handle('skills:deleteFile', async (_e, projectId: number, path: string) => {
    await deleteSkillFile(projectPath(projectId), path)
    notifyChanged(projectId)
  })

  // Project agent: assignment in .specify/integration.json, preferences in the app DB
  ipcMain.handle('project:getAgent', (_e, projectId: number, fallbackAgentId: string): ProjectAgentInfo => {
    const root = projectPath(projectId)
    const assigned = readIntegration(root).studioAgent
    const agentId = assigned ?? fallbackAgentId
    const agent = db.getAgent(agentId)
    return {
      agentId,
      inherited: !assigned,
      name: agent?.name ?? agentId,
      command: agent ? [agent.command, ...agent.args].join(' ') : '',
      status: !agent ? 'unknown-agent' : onPath(agent.command, root) ? 'ready' : 'missing-binary',
      preferences: db.getProjectAgentPreferences(projectId)
    }
  })
  ipcMain.handle('project:setAgent', (_e, projectId: number, agentId: string | null, preferences: ProjectAgentPreferences) => {
    if (agentId && !db.getAgent(agentId)) throw new Error(`Unknown agent ${agentId}`)
    writeStudioAgent(projectPath(projectId), agentId)
    db.setProjectAgentPreferences(projectId, preferences)
    notifyChanged(projectId)
  })

  // MCP servers in .mcp.json (the list comes with agentConfig:list)
  mutate('mcp:saveServer', (p, server: McpServerConfig, oldName?: string) => saveMcpServer(projectPath(p), server, oldName))
  mutate('mcp:toggleServer', (p, name: string, enabled: boolean) => toggleMcpServer(projectPath(p), name, enabled))
  mutate('mcp:deleteServer', (p, name: string) => deleteMcpServer(projectPath(p), name))

  ipcMain.handle('agentConfig:changes', (_e, runId: number) => {
    const run = getRun(runId)
    if (!run) return []
    const events = listRunEvents(runId)
    const baselineEv = events.find((e): e is { type: 'baseline'; files: Record<string, string | null> } => e.type === 'baseline')
    if (!baselineEv) return []
    const root = projectPath(run.projectId)
    return fileChanges(root, baselineEv.files)
  })
}
