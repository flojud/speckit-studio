import { DatabaseSync } from 'node:sqlite'
import { basename } from 'node:path'
import type { AgentConfig, AgentOptions, AnalysisSummary, GlobalAgentDefaults, PhaseConfig, PmData, Project, Run, RunEvent, RunStatus } from '../shared/types'

// Append-only: index + 1 = schema version stored in PRAGMA user_version.
const MIGRATIONS = [
  `create table projects (id integer primary key, path text not null unique, name text not null)`,
  `create table agents (id text primary key, name text not null, command text not null, args text not null default '[]', env text not null default '{}');
   insert into agents values ('claude', 'Claude Code', 'npx', '["-y","@agentclientprotocol/claude-agent-acp"]', '{}');
   create table runs (id integer primary key, project_id integer not null references projects(id) on delete cascade,
     spec_key text, agent text not null, prompt text not null, status text not null, started integer not null, ended integer);
   create table run_events (run_id integer not null references runs(id) on delete cascade, seq integer not null,
     json text not null, primary key (run_id, seq));`,
  `create table analysis_reports (run_id integer primary key references runs(id) on delete cascade, project_id integer not null,
     spec_key text not null, critical integer not null, markdown text not null, created integer not null);`,
  `create table epics (id integer primary key, project_id integer not null references projects(id) on delete cascade, title text not null, goal text not null default '');
   create table milestones (id integer primary key, project_id integer not null references projects(id) on delete cascade, title text not null, due text);
   create table spec_meta (project_id integer not null references projects(id) on delete cascade, spec_key text not null,
     epic_id integer references epics(id) on delete set null, milestone_id integer references milestones(id) on delete set null,
     primary key (project_id, spec_key));
   create table dependencies (project_id integer not null references projects(id) on delete cascade, spec_key text not null,
     blocked_by text not null, primary key (project_id, spec_key, blocked_by), check (spec_key <> blocked_by));`,
  `create table settings (key text primary key, value text not null)`,
  `create table work_item_meta (project_id integer not null references projects(id) on delete cascade, work_item_key text not null,
     epic_id integer references epics(id) on delete set null, milestone_id integer references milestones(id) on delete set null,
     primary key (project_id, work_item_key))`
]

let db: DatabaseSync

export function openDb(file: string): void {
  db = new DatabaseSync(file)
  db.exec('pragma foreign_keys = on')
  const { user_version } = db.prepare('pragma user_version').get() as { user_version: number }
  MIGRATIONS.slice(user_version).forEach((sql, i) => {
    db.exec(sql)
    db.exec(`pragma user_version = ${user_version + i + 1}`)
  })
}

export const listProjects = (): Project[] =>
  db.prepare('select id, path, name from projects order by name').all() as unknown as Project[]

export const getProject = (id: number): Project | undefined =>
  db.prepare('select id, path, name from projects where id = ?').get(id) as Project | undefined

export function addProject(path: string): Project {
  db.prepare('insert or ignore into projects (path, name) values (?, ?)').run(path, basename(path))
  return db.prepare('select id, path, name from projects where path = ?').get(path) as unknown as Project
}

export const removeProject = (id: number): void => {
  db.prepare('delete from projects where id = ?').run(id)
}

// --- agents

const toAgent = (r: Record<string, unknown>): AgentConfig => ({
  id: r.id as string,
  name: r.name as string,
  command: r.command as string,
  args: JSON.parse(r.args as string),
  env: JSON.parse(r.env as string)
})

export const listAgents = (): AgentConfig[] => db.prepare('select * from agents order by name').all().map(toAgent)

export function getAgent(id: string): AgentConfig | undefined {
  const r = db.prepare('select * from agents where id = ?').get(id)
  return r && toAgent(r)
}

export function upsertAgent(a: AgentConfig): void {
  db.prepare('insert or replace into agents values (?, ?, ?, ?, ?)').run(a.id, a.name, a.command, JSON.stringify(a.args), JSON.stringify(a.env))
}

export const deleteAgent = (id: string): void => {
  db.prepare('delete from agents where id = ?').run(id)
}

// --- settings (JSON values)

export function getSetting<T>(key: string, fallback: T): T {
  const r = db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined
  return r ? (JSON.parse(r.value) as T) : fallback
}

export const setSetting = (key: string, value: unknown): void => {
  db.prepare('insert or replace into settings values (?, ?)').run(key, JSON.stringify(value))
}

/** Configured model and effort overrides per Spec Kit command phase. Falls back to legacy phaseAgents. */
export const getPhaseConfigs = (): Record<string, PhaseConfig> => {
  const configs = getSetting<Record<string, PhaseConfig>>('phaseConfigs', {})
  if (configs && Object.keys(configs).length > 0) return configs
  const legacy = getSetting<Record<string, string>>('phaseAgents', {})
  const migrated: Record<string, PhaseConfig> = {}
  for (const [phase, agentId] of Object.entries(legacy)) {
    if (agentId) migrated[phase] = { agentId }
  }
  return migrated
}

/** Persists phase configuration overrides and updates legacy phaseAgents for backward compatibility. */
export const setPhaseConfigs = (configs: Record<string, PhaseConfig>): void => {
  setSetting('phaseConfigs', configs)
  const legacy: Record<string, string> = {}
  for (const [phase, cfg] of Object.entries(configs)) {
    if (cfg?.agentId) legacy[phase] = cfg.agentId
  }
  setSetting('phaseAgents', legacy)
}

/** Models and efforts an agent last reported (ACP configOptions), see runner `probeAgent`. */
export const getAgentOptions = (agentId: string): AgentOptions | null => getSetting<AgentOptions | null>(`agentOptions:${agentId}`, null)
export const setAgentOptions = (agentId: string, options: AgentOptions): void => setSetting(`agentOptions:${agentId}`, options)

/** Global default model and effort configuration. */
export const getGlobalDefaults = (): GlobalAgentDefaults =>
  getSetting<GlobalAgentDefaults>('globalAgentDefaults', {})

/** Persists global default model and effort configuration. */
export const setGlobalDefaults = (defaults: GlobalAgentDefaults): void => {
  setSetting('globalAgentDefaults', defaults)
}

/** Default agent per Spec Kit command, e.g. `{ specify: 'antigravity-acp', implement: 'claude' }`. */
export const getPhaseAgents = (): Record<string, string> => {
  const configs = getPhaseConfigs()
  const legacy: Record<string, string> = {}
  for (const [phase, cfg] of Object.entries(configs)) {
    if (cfg?.agentId) legacy[phase] = cfg.agentId
  }
  return legacy
}

/** Updates legacy phaseAgents while synchronizing with phaseConfigs. */
export const setPhaseAgents = (map: Record<string, string>): void => {
  const current = getPhaseConfigs()
  const next: Record<string, PhaseConfig> = { ...current }
  for (const [phase, agentId] of Object.entries(map)) {
    if (agentId) {
      next[phase] = { ...next[phase], agentId }
    } else {
      if (next[phase]) {
        delete next[phase].agentId
        if (!next[phase].model && !next[phase].effort) delete next[phase]
      }
    }
  }
  setPhaseConfigs(next)
}

// --- runs

const RUN_COLS = 'id, project_id as projectId, spec_key as specKey, agent, prompt, status, started, ended'

export function createRun(r: Omit<Run, 'id' | 'status' | 'started' | 'ended'>): Run {
  const { lastInsertRowid } = db
    .prepare("insert into runs (project_id, spec_key, agent, prompt, status, started) values (?, ?, ?, ?, 'running', ?)")
    .run(r.projectId, r.specKey, r.agent, r.prompt, Date.now())
  return db.prepare(`select ${RUN_COLS} from runs where id = ?`).get(lastInsertRowid) as unknown as Run
}

export const getRun = (id: number): Run | undefined =>
  db.prepare(`select ${RUN_COLS} from runs where id = ?`).get(id) as unknown as Run | undefined

export function setRunStatus(id: number, status: RunStatus): void {
  const ended = status === 'running' || status === 'waiting' ? null : Date.now()
  db.prepare('update runs set status = ?, ended = ? where id = ?').run(status, ended, id)
}

export const listRuns = (projectId: number, specKey?: string): Run[] =>
  (specKey === undefined
    ? db.prepare(`select ${RUN_COLS} from runs where project_id = ? order by id desc limit 100`).all(projectId)
    : db.prepare(`select ${RUN_COLS} from runs where project_id = ? and spec_key = ? order by id desc`).all(projectId, specKey)) as unknown as Run[]

/** Runs left active by a previous app session can't be resumed: their agent process is gone. */
export const failStaleRuns = (): void => {
  db.prepare("update runs set status = 'failed', ended = ? where status in ('running', 'waiting')").run(Date.now())
}

export function addRunEvent(runId: number, e: RunEvent): number {
  const { seq } = db.prepare('select coalesce(max(seq), 0) + 1 as seq from run_events where run_id = ?').get(runId) as { seq: number }
  db.prepare('insert into run_events values (?, ?, ?)').run(runId, seq, JSON.stringify(e))
  return seq
}

export const listRunEvents = (runId: number): RunEvent[] =>
  db.prepare('select json from run_events where run_id = ? order by seq').all(runId).map((r) => JSON.parse(r.json as string))

// --- analysis reports (Spec Kit's analyze writes no file)

export function saveAnalysis(runId: number, projectId: number, specKey: string, critical: number, markdown: string): void {
  db.prepare('insert or replace into analysis_reports values (?, ?, ?, ?, ?, ?)').run(runId, projectId, specKey, critical, markdown, Date.now())
}

/** Latest report per spec of a project. */
export const latestAnalyses = (projectId: number): (AnalysisSummary & { specKey: string })[] =>
  db
    .prepare(
      `select spec_key as specKey, run_id as runId, critical, created from analysis_reports a
       where project_id = ? and created = (select max(created) from analysis_reports b where b.project_id = a.project_id and b.spec_key = a.spec_key)`
    )
    .all(projectId) as unknown as (AnalysisSummary & { specKey: string })[]

export const getAnalysisMarkdown = (runId: number): string | null =>
  (db.prepare('select markdown from analysis_reports where run_id = ?').get(runId) as { markdown: string } | undefined)?.markdown ?? null

// --- PM layer (epics, milestones, assignments, dependencies)

export const getPm = (projectId: number): PmData => ({
  epics: db.prepare('select id, title, goal from epics where project_id = ? order by id').all(projectId) as unknown as PmData['epics'],
  milestones: db
    .prepare('select id, title, due from milestones where project_id = ? order by due is null, due, id')
    .all(projectId) as unknown as PmData['milestones'],
  meta: db
    .prepare('select spec_key as specKey, epic_id as epicId, milestone_id as milestoneId from spec_meta where project_id = ?')
    .all(projectId) as unknown as PmData['meta'],
  deps: db.prepare('select spec_key as specKey, blocked_by as blockedBy from dependencies where project_id = ? order by blocked_by').all(projectId) as unknown as PmData['deps'],
  workItemMeta: db
    .prepare('select work_item_key as workItemKey, epic_id as epicId, milestone_id as milestoneId from work_item_meta where project_id = ?')
    .all(projectId) as unknown as NonNullable<PmData['workItemMeta']>
})

export const createEpic = (projectId: number, title: string, goal = ''): void => {
  db.prepare('insert into epics (project_id, title, goal) values (?, ?, ?)').run(projectId, title, goal)
}
export const deleteEpic = (id: number): void => {
  db.prepare('delete from epics where id = ?').run(id)
}
export const createMilestone = (projectId: number, title: string, due: string | null): void => {
  db.prepare('insert into milestones (project_id, title, due) values (?, ?, ?)').run(projectId, title, due || null)
}
export function setMilestoneDue(projectId: number, id: number, due: string | null): void {
  if (due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('Invalid due date')
  db.prepare('update milestones set due = ? where id = ? and project_id = ?').run(due, id, projectId)
}
export const deleteMilestone = (id: number): void => {
  db.prepare('delete from milestones where id = ?').run(id)
}

export function setSpecMeta(projectId: number, specKey: string, field: 'epic_id' | 'milestone_id', value: number | null): void {
  db.prepare('insert or ignore into spec_meta (project_id, spec_key) values (?, ?)').run(projectId, specKey)
  db.prepare(`update spec_meta set ${field} = ? where project_id = ? and spec_key = ?`).run(value, projectId, specKey)
}

export const addDependency = (projectId: number, specKey: string, blockedBy: string): void => {
  if (specKey === blockedBy) throw new Error('A spec cannot block itself')
  db.prepare('insert or ignore into dependencies values (?, ?, ?)').run(projectId, specKey, blockedBy)
}
export const removeDependency = (projectId: number, specKey: string, blockedBy: string): void => {
  db.prepare('delete from dependencies where project_id = ? and spec_key = ? and blocked_by = ?').run(projectId, specKey, blockedBy)
}

/** Drops the PM links of a deleted spec (assignments and dependencies in both directions). */
export const forgetSpec = (projectId: number, specKey: string): void => {
  db.prepare('delete from spec_meta where project_id = ? and spec_key = ?').run(projectId, specKey)
  db.prepare('delete from dependencies where project_id = ? and (spec_key = ? or blocked_by = ?)').run(projectId, specKey, specKey)
}

export function setWorkItemMeta(projectId: number, key: string, field: 'epic_id' | 'milestone_id', value: number | null): void {
  db.prepare('insert or ignore into work_item_meta (project_id, work_item_key) values (?, ?)').run(projectId, key)
  db.prepare(`update work_item_meta set ${field} = ? where project_id = ? and work_item_key = ?`).run(value, projectId, key)
}

export const forgetWorkItem = (projectId: number, key: string): void => {
  db.prepare('delete from work_item_meta where project_id = ? and work_item_key = ?').run(projectId, key)
}
