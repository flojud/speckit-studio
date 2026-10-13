import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentConfig,
  AgentOptions,
  AgentConfigState,
  ConfigAgent,
  ConfigKind,
  FileChange,
  GlobalAgentDefaults,
  McpServerConfig,
  PhaseConfig,
  Project,
  ProjectAgentInfo,
  ProjectAgentPreferences,
  ProjectSnapshot,
  Run,
  RunEvent,
  WorkItem
} from '../shared/types'

const api = {
  agentConfig: {
    list: (projectId: number): Promise<AgentConfigState> => ipcRenderer.invoke('agentConfig:list', projectId),
    write: (projectId: number, path: string, content: string, force?: boolean): Promise<void> =>
      ipcRenderer.invoke('agentConfig:write', projectId, path, content, force),
    create: (projectId: number, kind: ConfigKind, agent: ConfigAgent, name: string, description: string): Promise<string> =>
      ipcRenderer.invoke('agentConfig:create', projectId, kind, agent, name, description),
    remove: (projectId: number, path: string): Promise<void> => ipcRenderer.invoke('agentConfig:delete', projectId, path),
    share: (projectId: number, dir: string): Promise<{ moved: string[] }> => ipcRenderer.invoke('agentConfig:share', projectId, dir),
    optimize: (projectId: number, agentId: string, path: string | null, instructions: string): Promise<number> =>
      ipcRenderer.invoke('agentConfig:optimize', projectId, agentId, path, instructions),
    changes: (runId: number): Promise<FileChange[]> => ipcRenderer.invoke('agentConfig:changes', runId),
    createSkillFile: (projectId: number, skillDir: string, rel: string, content = ''): Promise<string> =>
      ipcRenderer.invoke('skills:createFile', projectId, skillDir, rel, content),
    deleteSkillFile: (projectId: number, path: string): Promise<void> => ipcRenderer.invoke('skills:deleteFile', projectId, path)
  },
  projectAgent: {
    get: (projectId: number, fallbackAgentId: string): Promise<ProjectAgentInfo> => ipcRenderer.invoke('project:getAgent', projectId, fallbackAgentId),
    set: (projectId: number, agentId: string | null, preferences: ProjectAgentPreferences): Promise<void> =>
      ipcRenderer.invoke('project:setAgent', projectId, agentId, preferences)
  },
  mcp: {
    save: (projectId: number, server: McpServerConfig, oldName?: string): Promise<void> => ipcRenderer.invoke('mcp:saveServer', projectId, server, oldName),
    toggle: (projectId: number, name: string, enabled: boolean): Promise<void> => ipcRenderer.invoke('mcp:toggleServer', projectId, name, enabled),
    remove: (projectId: number, name: string): Promise<void> => ipcRenderer.invoke('mcp:deleteServer', projectId, name)
  },
  listProjects: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
  addProject: (): Promise<Project | null> => ipcRenderer.invoke('projects:add'),
  removeProject: (id: number): Promise<void> => ipcRenderer.invoke('projects:remove', id),
  hasActiveRun: (id: number): Promise<boolean> => ipcRenderer.invoke('projects:hasActiveRun', id),
  snapshot: (id: number): Promise<ProjectSnapshot> => ipcRenderer.invoke('project:snapshot', id),
  readFile: (id: number, rel: string): Promise<string | null> => ipcRenderer.invoke('project:readFile', id, rel),
  toggleTask: (projectId: number, specDir: string, taskId: string, done: boolean): Promise<void> =>
    ipcRenderer.invoke('tasks:toggle', projectId, specDir, taskId, done),
  writeFile: (projectId: number, rel: string, content: string): Promise<void> => ipcRenderer.invoke('files:write', projectId, rel, content),
  wiki: {
    create: (projectId: number, title: string, body = ''): Promise<string> => ipcRenderer.invoke('wiki:create', projectId, title, body),
    backlinks: (projectId: number, file: string): Promise<string[]> => ipcRenderer.invoke('wiki:backlinks', projectId, file),
    linkAgents: (projectId: number): Promise<string[]> => ipcRenderer.invoke('wiki:linkAgents', projectId)
  },
  drafts: {
    create: (projectId: number, title: string, description: string): Promise<string> => ipcRenderer.invoke('drafts:create', projectId, title, description),
    update: (projectId: number, key: string, title: string, description: string): Promise<void> =>
      ipcRenderer.invoke('drafts:update', projectId, key, title, description),
    remove: (projectId: number, key: string): Promise<void> => ipcRenderer.invoke('drafts:delete', projectId, key)
  },
  workItems: {
    create: (projectId: number, title: string, category: WorkItem['category'], initialContent = ''): Promise<string> =>
      ipcRenderer.invoke('workItems:create', projectId, title, category, initialContent),
    update: (projectId: number, key: string, updates: Partial<Pick<WorkItem, 'title' | 'category' | 'status' | 'body'>>): Promise<void> =>
      ipcRenderer.invoke('workItems:update', projectId, key, updates),
    remove: (projectId: number, key: string): Promise<void> => ipcRenderer.invoke('workItems:delete', projectId, key),
    startRun: (projectId: number, key: string, agentId: string, prompt: string): Promise<number> =>
      ipcRenderer.invoke('runs:startWorkItem', projectId, key, agentId, prompt)
  },
  readAnalysis: (runId: number): Promise<string | null> => ipcRenderer.invoke('analysis:read', runId),
  listAgents: (): Promise<AgentConfig[]> => ipcRenderer.invoke('agents:list'),
  listRuns: (projectId: number, specKey?: string): Promise<Run[]> => ipcRenderer.invoke('runs:list', projectId, specKey),
  runEvents: (runId: number): Promise<RunEvent[]> => ipcRenderer.invoke('runs:events', runId),
  startRun: (projectId: number, specKey: string | null, agentId: string, command: string, args = '', opts: { force?: boolean; worktree?: boolean } = {}): Promise<number> =>
    ipcRenderer.invoke('runs:start', projectId, specKey, agentId, command, args, opts),
  agents: {
    install: (registryId: string): Promise<AgentConfig> => ipcRenderer.invoke('agents:install', registryId),
    save: (agent: AgentConfig): Promise<void> => ipcRenderer.invoke('agents:save', agent),
    remove: (agentId: string): Promise<void> => ipcRenderer.invoke('agents:delete', agentId),
    phaseAgents: (): Promise<Record<string, string>> => ipcRenderer.invoke('settings:phaseAgents'),
    setPhaseAgents: (map: Record<string, string>): Promise<void> => ipcRenderer.invoke('settings:setPhaseAgents', map),
    phaseConfigs: (): Promise<Record<string, PhaseConfig>> => ipcRenderer.invoke('settings:phaseConfigs'),
    setPhaseConfigs: (configs: Record<string, PhaseConfig>): Promise<void> => ipcRenderer.invoke('settings:setPhaseConfigs', configs),
    globalDefaults: (): Promise<GlobalAgentDefaults> => ipcRenderer.invoke('settings:globalDefaults'),
    options: (agentId: string): Promise<AgentOptions | null> => ipcRenderer.invoke('agents:options', agentId),
    probe: (agentId: string): Promise<AgentOptions> => ipcRenderer.invoke('agents:probe', agentId),
    setGlobalDefaults: (defaults: GlobalAgentDefaults): Promise<void> => ipcRenderer.invoke('settings:setGlobalDefaults', defaults)
  },
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  settings: {
    get: <T>(key: string): Promise<T | null> => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown): Promise<void> => ipcRenderer.invoke('settings:set', key, value)
  },
  env: {
    tools: (): Promise<{ id: string; required: boolean; version?: string; hint: string }[]> => ipcRenderer.invoke('env:tools'),
    specifyInit: (projectId: number, integration: string): Promise<{ ok: boolean; output: string }> =>
      ipcRenderer.invoke('specify:init', projectId, integration)
  },
  git: {
    removeWorktree: (projectId: number, specKey: string): Promise<void> => ipcRenderer.invoke('git:removeWorktree', projectId, specKey),
    createPr: (projectId: number, specKey: string): Promise<string> => ipcRenderer.invoke('git:createPr', projectId, specKey)
  },
  pm: {
    createEpic: (projectId: number, title: string, goal = ''): Promise<void> => ipcRenderer.invoke('pm:epic:create', projectId, title, goal),
    deleteEpic: (projectId: number, id: number): Promise<void> => ipcRenderer.invoke('pm:epic:delete', projectId, id),
    createMilestone: (projectId: number, title: string, due: string | null): Promise<void> =>
      ipcRenderer.invoke('pm:milestone:create', projectId, title, due),
    deleteMilestone: (projectId: number, id: number): Promise<void> => ipcRenderer.invoke('pm:milestone:delete', projectId, id),
    setMilestoneDue: (projectId: number, id: number, due: string | null): Promise<void> =>
      ipcRenderer.invoke('pm:milestone:due', projectId, id, due),
    setMeta: (projectId: number, specKey: string, field: 'epic' | 'milestone', value: number | null): Promise<void> =>
      ipcRenderer.invoke('pm:meta:set', projectId, specKey, field, value),
    setWorkItemMeta: (projectId: number, key: string, field: 'epic' | 'milestone', value: number | null): Promise<void> =>
      ipcRenderer.invoke('pm:workItemMeta:set', projectId, key, field, value),
    addDep: (projectId: number, specKey: string, blockedBy: string): Promise<void> => ipcRenderer.invoke('pm:dep:add', projectId, specKey, blockedBy),
    removeDep: (projectId: number, specKey: string, blockedBy: string): Promise<void> =>
      ipcRenderer.invoke('pm:dep:remove', projectId, specKey, blockedBy)
  },
  replyRun: (runId: number, text: string): Promise<void> => ipcRenderer.invoke('runs:reply', runId, text),
  answerPermission: (runId: number, requestId: string, optionId: string | null): Promise<void> =>
    ipcRenderer.invoke('runs:answer', runId, requestId, optionId),
  cancelRun: (runId: number): Promise<void> => ipcRenderer.invoke('runs:cancel', runId),
  finishRun: (runId: number): Promise<void> => ipcRenderer.invoke('runs:finish', runId),
  onRunEvent: (cb: (runId: number, seq: number, event: RunEvent) => void): (() => void) => {
    const listener = (_e: unknown, runId: number, seq: number, event: RunEvent): void => cb(runId, seq, event)
    ipcRenderer.on('run:event', listener)
    return () => ipcRenderer.off('run:event', listener)
  },
  onChanged: (cb: (id: number) => void): (() => void) => {
    const listener = (_e: unknown, id: number): void => cb(id)
    ipcRenderer.on('project:changed', listener)
    return () => ipcRenderer.off('project:changed', listener)
  }
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)
