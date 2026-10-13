import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type McpServer } from '@agentclientprotocol/sdk'
import { pickConfig } from '../shared/runs.ts'
import type { AcpUpdate, AgentConfig, AgentOptions, PermissionOption } from '../shared/types'

export interface AgentHooks {
  onUpdate(update: AcpUpdate): void
  /** Resolve with the chosen optionId, or null to cancel the request. */
  onPermission(req: { title: string; kind?: string; options: PermissionOption[] }): Promise<string | null>
  /** Agent process ended (error text if it did not exit cleanly). */
  onExit(error?: string): void
  /** Informational message from the client side (e.g. sign-in in progress). */
  onNotice?(text: string): void
}

const AUTH_REQUIRED = -32000

export interface AgentSession {
  /** Models and efforts the agent offers, and the values this session uses. */
  options: AgentOptions
  prompt(text: string): Promise<string>
  cancel(): void
  close(): void
}

/**
 * Spawns an ACP agent over stdio, initializes it and opens one session in `cwd`. No Electron imports, so it is testable.
 * `want.model` / `want.effort` are set via ACP `session/set_config_option` when the agent offers them; otherwise a notice says so.
 * `want.mcpServers` go into `session/new`; http/sse servers only if the agent declares support for them.
 */
export async function startAgent(
  cfg: AgentConfig,
  cwd: string,
  env: Record<string, string>,
  hooks: AgentHooks,
  want: { model?: string; effort?: string; mcpServers?: McpServer[] } = {}
): Promise<AgentSession> {
  const child = spawn(cfg.command, cfg.args, { cwd, env: { ...process.env, ...cfg.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)))

  // Rejects as soon as the process fails, so pending ACP requests never hang.
  let closing = false
  const died = new Promise<never>((_, reject) => {
    child.on('error', (e) => reject(e))
    child.on('exit', (code, signal) => {
      const error = closing ? undefined : `Agent exited (${signal ?? code})${stderr ? `: ${stderr.trim()}` : ''}`
      hooks.onExit(error)
      reject(new Error(error ?? 'Agent closed'))
    })
  })
  died.catch(() => {})

  const conn = new ClientSideConnection(
    () => ({
      sessionUpdate: async (n) => hooks.onUpdate(n.update as AcpUpdate),
      requestPermission: async (p) => {
        const optionId = await hooks.onPermission({ title: p.toolCall.title ?? 'Permission requested', kind: p.toolCall.kind ?? undefined, options: p.options })
        return { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } }
      }
    }),
    ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)
  )

  const close = (): void => {
    closing = true
    child.kill()
  }
  try {
    const init = await Promise.race([conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }), died])
    const caps = init.agentCapabilities?.mcpCapabilities
    const mcpServers = (want.mcpServers ?? []).filter((s) => {
      if (!('type' in s) || (s.type !== 'http' && s.type !== 'sse') || caps?.[s.type]) return true
      hooks.onNotice?.(`MCP server "${s.name}" skipped: ${cfg.name} does not support ${s.type} MCP servers.`)
      return false
    })
    const newSession = (): ReturnType<typeof conn.newSession> => Promise.race([conn.newSession({ cwd, mcpServers }), died])
    let session: Awaited<ReturnType<typeof conn.newSession>>
    try {
      session = await newSession()
    } catch (e) {
      // ACP "auth required": let the agent sign in (it opens the browser), then retry once.
      const methods = init.authMethods ?? []
      if ((e as { code?: number }).code !== AUTH_REQUIRED || !methods.length) throw e
      const method = methods.find((m) => /oauth/i.test(m.id)) ?? methods[0]
      hooks.onNotice?.(`Signing in via ${method.name} – complete the sign-in in your browser if it opens.`)
      await Promise.race([conn.authenticate({ methodId: method.id }), died])
      session = await newSession()
    }
    const { sessionId } = session
    let configOptions = session.configOptions
    // Model first: the effort choices can depend on the model.
    for (const [category, value, label] of [['model', want.model, 'Model'], ['thought_level', want.effort, 'Effort']] as const) {
      if (!value) continue
      const opt = pickConfig(configOptions, category)
      if (!opt?.choices.some((c) => c.value === value)) {
        hooks.onNotice?.(`${label} "${value}" is not offered by ${cfg.name}${opt?.current ? `, using ${opt.current}` : ''}.`)
        continue
      }
      if (opt.current === value) continue
      ;({ configOptions } = await Promise.race([conn.setSessionConfigOption({ sessionId, configId: opt.id, value }), died]))
    }
    const model = pickConfig(configOptions, 'model')
    const effort = pickConfig(configOptions, 'thought_level')
    return {
      options: { models: model?.choices ?? [], efforts: effort?.choices ?? [], model: model?.current, effort: effort?.current },
      prompt: async (text) => (await Promise.race([conn.prompt({ sessionId, prompt: [{ type: 'text', text }] }), died])).stopReason,
      cancel: () => void conn.cancel({ sessionId }).catch(() => {}),
      close
    }
  } catch (e) {
    close()
    throw e
  }
}

/** Opens a session without prompting (no tokens used) to read which models and efforts the agent offers. */
export async function probeAgent(cfg: AgentConfig, cwd: string): Promise<AgentOptions> {
  const session = await startAgent(cfg, cwd, {}, { onUpdate: () => {}, onPermission: async () => null, onExit: () => {} })
  session.close()
  return { ...session.options, at: new Date().toISOString() }
}
