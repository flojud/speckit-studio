import electron from 'electron'
const BrowserWindow = typeof electron === 'object' && electron !== null ? (electron as typeof import('electron')).BrowserWindow : undefined
import type { RunEvent, RunStatus } from '../shared/types.ts'
import { countCritical } from '../shared/clarify.ts'
import { applyDangerousPermissions, autoAnswer, resolveEffectiveConfig, runPrompt, withInstructions } from '../shared/runs.ts'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { addRunEvent, createRun, getAgent, getGlobalDefaults, getPhaseConfigs, getPm, getProject, getProjectAgentPreferences, getSetting, saveAnalysis, setAgentOptions, setRunStatus } from './db.ts'
import { addWorktree, commitSpec, ensureBranch, WORKTREES } from './git.ts'
import { applyPm } from '../shared/pm.ts'
import { readMcpConfig, toAcpMcpServers, validateMcpConfig } from './mcp.ts'
import { startAgent, type AgentSession } from './runner.ts'
import { readIntegration, readProject } from './speckit.ts'

interface Active {
  projectId: number
  specKey: string | null
  /** Working directory: the repo or a spec worktree. */
  cwd: string
  command: string
  /** Agent text of the current turn (saved as report for analyze runs). */
  turnText: string
  session?: AgentSession
  permissions: Map<string, (optionId: string | null) => void>
  status: RunStatus
}

export const WORK_ITEM_COMMAND = 'work-item'

const active = new Map<number, Active>()
/** Working trees where a run is being started (git switch in flight), so a second start can't slip in. */
const starting = new Set<string>()

let permissionSeq = 0

function emit(runId: number, event: RunEvent): void {
  const seq = addRunEvent(runId, event)
  BrowserWindow?.getAllWindows?.()?.forEach((w) => w.webContents.send('run:event', runId, seq, event))
}

function setStatus(runId: number, status: RunStatus, error?: string): void {
  const run = active.get(runId)
  if (run) run.status = status
  setRunStatus(runId, status)
  emit(runId, { type: 'status', status, ...(error ? { error } : {}) })
  if (status !== 'running' && status !== 'waiting') {
    run?.session?.close()
    run?.permissions.forEach((resolve) => resolve(null))
    active.delete(runId)
  }
}

async function turn(runId: number, text: string): Promise<void> {
  const run = active.get(runId)
  if (!run?.session) return
  if (run.status !== 'running') setStatus(runId, 'running')
  run.turnText = ''
  try {
    const stop = await run.session.prompt(text)
    if (!active.has(runId)) return // finished/cancelled meanwhile
    if (run.command === 'analyze' && run.specKey && stop === 'end_turn' && run.turnText.trim())
      saveAnalysis(runId, run.projectId, run.specKey, countCritical(run.turnText), run.turnText)
    // Each finished implement turn lands as a commit on the spec branch; a failed commit never fails the run.
    if (run.command === 'implement' && run.specKey && stop === 'end_turn') {
      const hash = await commitSpec(run.cwd, run.specKey).catch((e: Error) => e)
      if (hash) emit(runId, { type: 'notice', text: hash instanceof Error ? `Not committed: ${hash.message}` : `Committed ${hash} on ${run.specKey}` })
    }
    setStatus(runId, stop === 'cancelled' ? 'cancelled' : 'waiting')
  } catch (e) {
    if (active.has(runId)) setStatus(runId, 'failed', (e as Error).message)
  }
}

export interface StartOptions {
  force?: boolean
  /** Run in the spec's git worktree (created if missing). Specs that already have one always run there. */
  worktree?: boolean
  prompt?: string
  baseline?: Record<string, string | null>
}

/**
 * Starts `<prefix><command> <args>`. The agent is the phase default from settings, else the project agent, else `agentId`.
 * One active run per spec and per working directory, so worktree runs can go in parallel.
 * `implement` on a blocked spec needs `force`.
 */
export async function startRun(projectId: number, specKey: string | null, agentId: string, command: string, args: string, opts: StartOptions = {}): Promise<number> {
  const project = getProject(projectId)
  const phaseConfigs = getPhaseConfigs()
  const globalDefaults = getGlobalDefaults()
  const preferences = getProjectAgentPreferences(projectId)
  const projectAgent = project ? readIntegration(project.path).studioAgent : undefined
  const effective = resolveEffectiveConfig(command, phaseConfigs, globalDefaults, agentId, { agentId: projectAgent, preferences })
  const targetAgentId = effective.agentId ?? agentId
  const baseAgent = getAgent(targetAgentId) ?? getAgent(agentId)
  if (!project || !baseAgent) throw new Error('Unknown project or agent')
  const dangerouslySkip = getSetting<boolean>('dangerouslySkipPermissions', false)
  const agent = applyDangerousPermissions(baseAgent, dangerouslySkip)
  const force = opts.force
  const existing = specKey ? resolve(project.path, WORKTREES, specKey) : undefined
  const cwd = specKey && (opts.worktree || existsSync(existing!)) ? await addWorktree(project.path, specKey) : project.path
  for (const r of active.values()) {
    if (specKey && r.projectId === projectId && r.specKey === specKey) throw new Error(`A run for ${specKey} is already active.`)
    if (r.cwd === cwd) throw new Error('Another run is active in this working tree. Finish or cancel it, or use "Implement in worktree".')
  }
  if (starting.has(cwd)) throw new Error('Another run is starting in this working tree.')

  const { commandPrefix, specs } = readProject(project.path) // ponytail: blocked check reads main-tree phases, not worktree copies
  if (command === 'implement' && specKey && !force) {
    applyPm(specs, getPm(projectId))
    const spec = specs.find((s) => s.key === specKey)
    if (spec?.blocked) throw new Error(`BLOCKED: ${specKey} is blocked by ${spec.blockedBy!.join(', ')}. Use "Run anyway" to implement regardless.`)
  }
  // Specify on a draft: the description comes from draft.md. Specify and implement check out the spec branch in the
  // main tree before the agent starts (implement only from a clean tree), so the work lands there.
  let branch: string | undefined
  if (command === 'specify' && specKey) {
    if (!args.trim()) args = specs.find((s) => s.key === specKey)?.description ?? ''
    if (!args.trim()) throw new Error('Add a description to the draft first.')
  }
  if ((command === 'specify' || command === 'implement') && specKey && cwd === project.path) {
    starting.add(cwd)
    try {
      if (await ensureBranch(project.path, specKey, command === 'implement')) branch = specKey
    } finally {
      starting.delete(cwd)
    }
  }
  // Work item runs are keyed by the item but are not Spec Kit features.
  const dir = specKey && command !== WORK_ITEM_COMMAND ? `specs/${specKey}` : undefined
  const prompt = withInstructions(opts.prompt ?? runPrompt(commandPrefix, command, args, specKey, branch), preferences.instructions)
  const run = createRun({ projectId, specKey, agent: agent.id, prompt })
  const entry: Active = { projectId, specKey, cwd, command, turnText: '', permissions: new Map(), status: 'running' }
  active.set(run.id, entry)
  if (opts.baseline) emit(run.id, { type: 'baseline', files: opts.baseline })
  emit(run.id, { type: 'user', text: prompt })

  // Project MCP servers (.mcp.json of the main tree, also for worktree runs); a broken file never blocks the run.
  const mcp = readMcpConfig(project.path)
  const mcpServers = toAcpMcpServers(mcp.servers)
  if (mcp.error) emit(run.id, { type: 'notice', text: `.mcp.json has a syntax error, starting without MCP servers: ${mcp.error}` })
  for (const f of validateMcpConfig(project.path)) if (f.rule === 'mcp-missing-binary') emit(run.id, { type: 'notice', text: f.reason })
  if (mcpServers.length) emit(run.id, { type: 'notice', text: `MCP servers: ${mcpServers.map((s) => s.name).join(', ')}` })

  startAgent(agent, cwd, { ...(dir ? { SPECIFY_FEATURE_DIRECTORY: dir } : {}), ...(branch ? { GIT_BRANCH_NAME: branch } : {}) }, {
    onUpdate: (update) => {
      const a = active.get(run.id)
      if (a && update.sessionUpdate === 'agent_message_chunk' && update.content?.text) a.turnText += update.content.text
      emit(run.id, { type: 'update', update })
    },
    onPermission: ({ kind, ...req }) => {
      const requestId = `p${++permissionSeq}`
      const skip = getSetting<boolean>('dangerouslySkipPermissions', false)
      const auto = autoAnswer(kind, req.options, getSetting('autoApproveReads', false), skip)
      if (auto) {
        emit(run.id, {
          type: 'notice',
          text: skip ? `Auto-approved (dangerously skip permissions): ${req.title}` : `Auto-approved (read-only): ${req.title}`
        })
        return Promise.resolve(auto)
      }
      return new Promise((resolve) => {
        active.get(run.id)?.permissions.set(requestId, resolve)
        emit(run.id, { type: 'permission', requestId, ...req })
      })
    },
    onNotice: (text) => emit(run.id, { type: 'notice', text }),
    onExit: (error) => active.get(run.id) === entry && setStatus(run.id, error ? 'failed' : 'done', error)
  }, { model: effective.model, effort: effective.effort, mcpServers })
    .then((session) => {
      const { options } = session
      setAgentOptions(baseAgent.id, { ...options, at: new Date().toISOString() })
      // Identity, not id: the run may have been cancelled while the agent was starting.
      const a = active.get(run.id)
      if (a !== entry) return session.close()
      a.session = session
      // What the agent actually uses, not what was asked for.
      if (options.model || options.effort)
        emit(run.id, {
          type: 'notice',
          text: `Active configuration: ${[baseAgent.name, options.model ? `model: ${options.model}` : null, options.effort ? `effort: ${options.effort}` : null].filter(Boolean).join(' · ')}`
        })
      return turn(run.id, prompt)
    })
    .catch((e) => active.get(run.id) === entry && setStatus(run.id, 'failed', (e as Error).message))
  return run.id
}

export function replyRun(runId: number, text: string): void {
  if (active.get(runId)?.status !== 'waiting') throw new Error('Run is not waiting for input')
  emit(runId, { type: 'user', text })
  void turn(runId, text)
}

export function answerPermission(runId: number, requestId: string, optionId: string | null): void {
  const resolve = active.get(runId)?.permissions.get(requestId)
  if (!resolve) return
  active.get(runId)!.permissions.delete(requestId)
  emit(runId, { type: 'answer', requestId, optionId })
  resolve(optionId)
}

export function cancelRun(runId: number): void {
  const run = active.get(runId)
  if (!run) return
  run.session?.cancel()
  setStatus(runId, 'cancelled')
}

export const finishRun = (runId: number): void => void (active.has(runId) && setStatus(runId, 'done'))

export const closeAllRuns = (): void => [...active.keys()].forEach(cancelRun)

export function hasActiveRun(projectId: number): boolean {
  for (const r of active.values()) {
    if (r.projectId === projectId && (r.status === 'running' || r.status === 'waiting')) {
      return true
    }
  }
  return false
}

export function cancelProjectRuns(projectId: number): void {
  for (const [runId, r] of active.entries()) {
    if (r.projectId === projectId) {
      cancelRun(runId)
    }
  }
}
