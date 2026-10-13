import type { ConfigChoice, EffectiveRunConfig, GlobalAgentDefaults, PermissionOption, PhaseConfig, ProjectAgentPreferences, RunEvent, RunStatus, WorkItem } from './types'

export type RunItem =
  | { kind: 'message'; role: 'agent' | 'user' | 'thought' | 'notice'; text: string }
  | { kind: 'tool'; id: string; title: string; toolKind?: string; status: string }

export interface FoldedRun {
  items: RunItem[]
  plan: { content: string; status: string }[]
  permission?: { requestId: string; title: string; options: PermissionOption[] }
  status: RunStatus
  error?: string
  activeConfig?: { model?: string; effort?: string }
}

const ROLE: Record<string, 'agent' | 'user' | 'thought'> = {
  agent_message_chunk: 'agent',
  user_message_chunk: 'user',
  agent_thought_chunk: 'thought'
}

/** Folds a run's ordered events into what the run panel shows. Pure, so live and replayed runs look the same. */
export function foldEvents(events: RunEvent[]): FoldedRun {
  const run: FoldedRun = { items: [], plan: [], status: 'running' }
  const tools = new Map<string, Extract<RunItem, { kind: 'tool' }>>()
  const append = (role: 'agent' | 'user' | 'thought', text: string): void => {
    const last = run.items.at(-1)
    if (last?.kind === 'message' && last.role === role) last.text += text
    else run.items.push({ kind: 'message', role, text })
  }

  for (const e of events) {
    if (e.type === 'baseline') continue
    if (e.type === 'status') {
      run.status = e.status
      run.error = e.error
    } else if (e.type === 'user' || e.type === 'notice') {
      run.items.push({ kind: 'message', role: e.type, text: e.text })
      if (e.type === 'notice' && e.text.startsWith('Active configuration:')) {
        const parts = e.text.slice('Active configuration:'.length).split(' · ')
        let model: string | undefined
        let effort: string | undefined
        for (const part of parts) {
          const trimmed = part.trim()
          if (trimmed.startsWith('model: ')) model = trimmed.slice(7).trim()
          if (trimmed.startsWith('effort: ')) effort = trimmed.slice(8).trim()
        }
        if (model || effort) run.activeConfig = { model, effort }
      }
    } else if (e.type === 'permission') {
      run.permission = { requestId: e.requestId, title: e.title, options: e.options }
    } else if (e.type === 'answer') {
      if (run.permission?.requestId === e.requestId) run.permission = undefined
    } else {
      const u = e.update
      const role = ROLE[u.sessionUpdate]
      if (role) {
        if (u.content?.type === 'text' && u.content.text) append(role, u.content.text)
      } else if (u.sessionUpdate === 'tool_call' && u.toolCallId) {
        const item = { kind: 'tool' as const, id: u.toolCallId, title: u.title ?? 'Tool call', toolKind: u.kind ?? undefined, status: u.status ?? 'pending' }
        tools.set(item.id, item)
        run.items.push(item)
      } else if (u.sessionUpdate === 'tool_call_update' && u.toolCallId) {
        const item = tools.get(u.toolCallId)
        if (item) {
          if (u.title) item.title = u.title
          if (u.status) item.status = u.status
        }
      } else if (u.sessionUpdate === 'plan' && u.entries) {
        run.plan = u.entries.map(({ content, status }) => ({ content, status }))
      }
    }
  }
  return run
}

const READ_ONLY = ['read', 'search', 'think', 'fetch']

/** Matches agents that support `--dangerously-skip-permissions` CLI flag (e.g. Claude Code, Antigravity / agy CLI). */
export function isDangerousPermissionsSupported(agent: { id?: string; name?: string; command?: string; args?: string[] }): boolean {
  if (agent.command?.endsWith('.par') || agent.command?.includes('agy_acp_server')) return false
  const matches = (s?: string): boolean => !!s && /(claude|agy)/i.test(s)
  return matches(agent.id) || matches(agent.name) || matches(agent.command) || (agent.args?.some((a) => matches(a)) ?? false)
}

/** If dangerouslySkip is enabled and the agent supports it, adds `--dangerously-skip-permissions` to args without duplicates. */
export function applyDangerousPermissions<T extends { id?: string; name?: string; command?: string; args: string[] }>(agent: T, enabled: boolean): T {
  if (!enabled || !isDangerousPermissionsSupported(agent)) return agent
  if (agent.args.includes('--dangerously-skip-permissions')) return agent
  return { ...agent, args: [...agent.args, '--dangerously-skip-permissions'] }
}

/** Permission policy: with `dangerouslySkip`, all calls are auto-approved; with `enabled`, read-only tool calls are approved once without asking. */
export function autoAnswer(kind: string | undefined, options: PermissionOption[], enabled: boolean, dangerouslySkip = false): string | null {
  if (dangerouslySkip) {
    return (
      options.find((o) => o.kind === 'allow_always')?.optionId ??
      options.find((o) => o.kind === 'allow_once')?.optionId ??
      options.find((o) => o.kind.startsWith('allow'))?.optionId ??
      options[0]?.optionId ??
      null
    )
  }
  if (!enabled || !kind || !READ_ONLY.includes(kind)) return null
  return options.find((o) => o.kind === 'allow_once')?.optionId ?? options.find((o) => o.kind.startsWith('allow'))?.optionId ?? null
}

/** `<prefix><command> <args>`, the target spec folder and the spec branch main checked out (specify, implement). */
export const runPrompt = (prefix: string, command: string, args: string, specKey: string | null, branch?: string): string =>
  `${prefix}${command}${args.trim() ? ` ${args.trim()}` : ''}${specKey ? `\n\nTarget feature directory: specs/${specKey}` : ''}${branch ? `\nGit branch: ${branch} (already checked out)` : ''}`

/** Appends the project's standing instructions to a run prompt. */
export const withInstructions = (prompt: string, instructions?: string): string =>
  instructions?.trim() ? `${prompt}\n\nProject instructions:\n${instructions.trim()}` : prompt

/** Plain prompt (no Spec Kit command) for an agent run on a non-code work item. */
export const workItemPrompt = (w: Pick<WorkItem, 'file' | 'title' | 'category' | 'status' | 'body'>, request: string): string =>
  `You are working on the following product work item: ${w.file}

## Work Item Metadata
Title: ${w.title}
Category: ${w.category}
Status: ${w.status}

## Current Content
${w.body.trim() || '(empty)'}

## User Request
${request.trim()}

Edit ${w.file} in place (keep its frontmatter) unless the request asks for other files, e.g. wiki pages under docs/wiki/.`

/** The select option of an ACP session's `configOptions` with this category (`model`, `thought_level`), groups flattened. */
export function pickConfig(
  configOptions: { id: string; type?: string; category?: string | null; currentValue?: unknown; options?: unknown }[] | null | undefined,
  category: string
): { id: string; current?: string; choices: ConfigChoice[] } | undefined {
  const o = configOptions?.find((c) => c.category === category && c.type === 'select')
  if (!o) return undefined
  const raw = (Array.isArray(o.options) ? o.options : []) as (ConfigChoice | { group: string; options: ConfigChoice[] })[]
  const choices = raw.flatMap((c) => ('group' in c ? c.options : [c])).map(({ value, name, description }) => ({ value, name, ...(description ? { description } : {}) }))
  return { id: o.id, current: typeof o.currentValue === 'string' ? o.currentValue : undefined, choices }
}

/**
 * Resolves the effective execution configuration for a given phase command.
 * Agent: phase override -> project agent -> fallback (header selection).
 * Model and effort: phase override -> project preference -> global default -> agent default.
 */
export function resolveEffectiveConfig(
  command: string,
  phaseConfigs?: Record<string, PhaseConfig>,
  globalDefaults?: GlobalAgentDefaults,
  fallbackAgentId?: string,
  project?: { agentId?: string; preferences?: ProjectAgentPreferences }
): EffectiveRunConfig {
  const phase = phaseConfigs?.[command]
  const prefs = project?.preferences
  const agentId = phase?.agentId?.trim() || project?.agentId?.trim() || fallbackAgentId
  const model = phase?.model?.trim() || prefs?.model?.trim() || globalDefaults?.model?.trim() || undefined
  const effort = phase?.effort?.trim() || prefs?.effort?.trim() || globalDefaults?.effort?.trim() || undefined

  return {
    agentId,
    model,
    effort
  }
}
