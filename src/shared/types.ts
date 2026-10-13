import type { WikiPage } from './wiki'

export const PHASES = ['draft', 'specified', 'clarified', 'planned', 'tasked', 'implementing', 'done'] as const
export type Phase = (typeof PHASES)[number]

export interface Task {
  id: string
  done: boolean
  parallel: boolean
  story?: string
  text: string
  section: string
}

export interface Artifact {
  /** path relative to the spec folder, e.g. `plan.md` or `contracts/api.md` */
  file: string
  mtime: number
  stale: boolean
}

export interface Spec {
  key: string
  number: string
  title: string
  phase: Phase
  artifacts: Artifact[]
  tasks: Task[]
  openClarifications: number
  /** Body of `draft.md`; only set while the spec is a draft (no `spec.md`). */
  description?: string
  /** Latest `/analyze` result (from the app database, not a file). */
  analysis?: AnalysisSummary
  /** PM layer (app database): */
  epicId?: number | null
  milestoneId?: number | null
  blockedBy?: string[]
  /** At least one existing blocker is not Done. */
  blocked?: boolean
  /** Folder of the spec relative to the repo (inside a studio worktree while one exists). */
  dir: string
  git?: { state: 'none' | 'branch' | 'merged'; worktree: boolean }
}

export const WORK_ITEM_CATEGORIES = ['business-plan', 'marketing', 'wiki-doc', 'research', 'operations', 'general'] as const
export type WorkItemCategory = (typeof WORK_ITEM_CATEGORIES)[number]
export const WORK_ITEM_STATUSES = ['draft', 'in-progress', 'review', 'done'] as const
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number]

/** Non-code deliverable: `work-items/<key>.md` with title/category/status frontmatter. */
export interface WorkItem {
  /** Immutable, = file name without `.md`, e.g. `WI-001-q4-marketing-strategy` */
  key: string
  /** Repo-relative path */
  file: string
  title: string
  category: WorkItemCategory
  status: WorkItemStatus
  /** Markdown after the frontmatter */
  body: string
  mtime: number
  /** PM layer (app database): */
  epicId?: number | null
  milestoneId?: number | null
}

export interface DashboardMetrics {
  kanbanFlow: {
    total: number
    /** Everything past draft and not done */
    wip: number
    /** Spec phases; work items map in-progress → implementing, review → review */
    byStage: Record<Phase | 'review', number>
    bottlenecks: { unresolvedClarifications: number; blockedSpecs: number }
  }
  scrumCadence: {
    activeMilestones: { id: number; title: string; due: string | null; totalItems: number; doneItems: number; percentComplete: number; overdue: boolean }[]
  }
  safeStrategic: {
    epics: { id: number; title: string; goal: string; totalItems: number; doneItems: number; percentComplete: number }[]
    unassignedItemsCount: number
  }
}

export interface Epic {
  id: number
  title: string
  goal: string
}

export interface Milestone {
  id: number
  title: string
  due: string | null
}

export interface PmData {
  epics: Epic[]
  milestones: Milestone[]
  meta: { specKey: string; epicId: number | null; milestoneId: number | null }[]
  deps: { specKey: string; blockedBy: string }[]
  workItemMeta?: { workItemKey: string; epicId: number | null; milestoneId: number | null }[]
}

export interface AnalysisSummary {
  runId: number
  critical: number
  created: number
}

export interface Constitution {
  mtime?: number
  version?: string
  ratified?: string
  amended?: string
}

export interface ProjectSnapshot {
  path: string
  initialized: boolean
  missing: boolean
  integration?: string
  /** Studio agent assigned to the project (`studio_agent` in `.specify/integration.json`) */
  studioAgent?: string
  /** e.g. `/speckit-` (Claude skills) or `/speckit.` (most other agents) */
  commandPrefix: string
  constitution?: Constitution
  specs: Spec[]
  workItems: WorkItem[]
  epics?: Epic[]
  milestones?: Milestone[]
  wiki: WikiPage[]
  git?: { defaultBranch?: string }
}

export interface Project {
  id: number
  path: string
  name: string
}

export interface RemoveProjectState {
  project: Project
  hasActiveRun: boolean
}

export interface ProjectContextMenu {
  x: number
  y: number
  project: Project
}

export interface AgentConfig {
  id: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'

export interface Run {
  id: number
  projectId: number
  specKey: string | null
  agent: string
  prompt: string
  status: RunStatus
  started: number
  ended: number | null
}

export interface PermissionOption {
  optionId: string
  name: string
  kind: string
}

/** Minimal structural view of an ACP SessionUpdate; unknown variants are ignored by the UI. */
export interface AcpUpdate {
  sessionUpdate: string
  content?: { type: string; text?: string }
  toolCallId?: string
  title?: string | null
  kind?: string | null
  status?: string | null
  entries?: { content: string; status: string }[]
}

export type RunEvent =
  | { type: 'update'; update: AcpUpdate }
  | { type: 'permission'; requestId: string; title: string; options: PermissionOption[] }
  | { type: 'answer'; requestId: string; optionId: string | null }
  | { type: 'user'; text: string }
  | { type: 'notice'; text: string }
  | { type: 'status'; status: RunStatus; error?: string }
  /** Optimize runs: file contents before the run (`null` = missing), for the per-file "Changes" view. */
  | { type: 'baseline'; files: Record<string, string | null> }

// --- agent configuration (CLAUDE.md, GEMINI.md, AGENTS.md, skills, subagents)

export type ConfigAgent = 'claude' | 'gemini' | 'shared'
export type ConfigKind = 'context' | 'skill' | 'subagent'

export interface ConfigItem {
  /** Repo-relative path of the main file: `CLAUDE.md`, `pkg/GEMINI.md`, `.claude/skills/review/SKILL.md`, `.claude/agents/x.md` */
  path: string
  kind: ConfigKind
  agent: ConfigAgent
  /** Frontmatter `name`, else the folder name (skill), file name without `.md` (subagent), or `path` (context file) */
  name: string
  description?: string
  size: number
  mtime: number
  /** Symlink or resolves outside the project → never written */
  readOnly: boolean
  /** Skills only: other files in the skill folder, relative to it */
  extraFiles?: string[]
  /** Context files only: 1-based line ranges of Spec Kit managed blocks */
  managed?: { start: number; end: number }[]
}

export type FindingRule =
  | 'too-long'
  | 'missing-reference'
  | 'missing-name'
  | 'missing-description'
  | 'bad-frontmatter'
  | 'vague-description'
  | 'long-description'
  | 'duplicate-name'
  | 'broken-markers'
  | 'section-conflict'
  | 'mcp-syntax-error'
  | 'mcp-invalid-name'
  | 'mcp-missing-command'
  | 'mcp-missing-url'
  | 'mcp-duplicate-name'
  | 'mcp-missing-binary'

export interface Finding {
  file: string
  /** 1-based */
  line?: number
  /** MCP findings: the server in `.mcp.json` they belong to */
  server?: string
  rule: FindingRule
  severity: 'warning' | 'error'
  reason: string
  fix: string
}

export interface SectionDiff {
  /** Folder holding both CLAUDE.md and GEMINI.md, '' = root */
  dir: string
  drift: { heading: string; only: 'claude' | 'gemini' }[]
  conflicts: { heading: string; claudeLine: number; geminiLine: number }[]
  /** Headings that "Use one shared file" would move to AGENTS.md */
  shared: string[]
}

export interface AgentConfigState {
  items: ConfigItem[]
  findings: Finding[]
  sync: SectionDiff[]
  isRepo: boolean
  /** Project MCP servers from `.mcp.json` */
  mcp: McpState
}

export interface FileChange {
  path: string
  status: 'modified' | 'created' | 'deleted' | 'too-large'
  lines: { op: ' ' | '+' | '-'; text: string }[]
}

/** Effort value as offered by the agent's `thought_level` config option (e.g. 'low', 'high'). */
export type EffortLevel = string

/** One selectable value of an ACP session config option. */
export interface ConfigChoice {
  value: string
  name: string
  description?: string
}

/** Models and efforts an agent reports for a new session (ACP configOptions), cached per agent. */
export interface AgentOptions {
  models: ConfigChoice[]
  efforts: ConfigChoice[]
  /** Values the session actually uses */
  model?: string
  effort?: string
  /** ISO time the options were read */
  at?: string
}

export interface PhaseConfig {
  /** Assigned agent ID, or undefined/empty to inherit the global header agent selection */
  agentId?: string
  /** Model value offered by the agent (e.g. 'sonnet', 'gemini-3.8-flash-high'), or undefined for the agent default */
  model?: string
  /** Reasoning effort override, or undefined for default */
  effort?: EffortLevel | ''
}

export interface GlobalAgentDefaults {
  /** Default model applied across all phases unless overridden */
  model?: string
  /** Default reasoning effort applied across all phases unless overridden */
  effort?: EffortLevel | ''
}

/** Studio-only run preferences of one project (settings key `projectAgentPreferences:<projectId>`). */
export interface ProjectAgentPreferences {
  model?: string
  effort?: EffortLevel
  /** Appended to every run prompt of the project */
  instructions?: string
}

export interface ProjectAgentInfo {
  /** Effective agent: the project's assignment, else the agent the renderer passed */
  agentId: string
  /** No `studio_agent` in `.specify/integration.json` */
  inherited: boolean
  name: string
  command: string
  status: 'ready' | 'missing-binary' | 'unknown-agent'
  preferences: ProjectAgentPreferences
}

export type McpTransportType = 'stdio' | 'sse' | 'http'

/** One entry of `.mcp.json` `mcpServers`; `name` is its key. */
export interface McpServerConfig {
  name: string
  /** Omitted = stdio */
  type?: McpTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
}

export interface McpState {
  servers: McpServerConfig[]
  exists: boolean
  /** JSON syntax error */
  error?: string
}

export interface EffectiveRunConfig {
  /** Resolved agent configuration */
  agent?: AgentConfig
  /** Resolved agent ID */
  agentId?: string
  /** Effective model argument, if any */
  model?: string
  /** Effective reasoning effort level, if any */
  effort?: EffortLevel
}

export type StepIconName = 'compass' | 'folder-git' | 'kanban' | 'file-text' | 'workflow' | 'cpu' | 'command'
export type StepActionTarget = 'settings' | 'palette' | 'constitution' | 'dashboard'

export interface StepAction {
  label: string
  target: StepActionTarget
}

/** One entry of the onboarding guide catalog; `version` is the app semver the step was introduced in. */
export interface OnboardingStep {
  id: string
  title: string
  category: string
  summary: string
  highlights: string[]
  icon: StepIconName
  version: string
  action?: StepAction
}

/** Stored in the `settings` table under key 'onboarding'. Written only on finish, skip/close or a step action. */
export interface OnboardingPreferences {
  completed: boolean
  dismissed: boolean
  lastSeenVersion: string
  completedAt?: string
}

export type OnboardingGuideMode = 'all' | 'whats-new'
