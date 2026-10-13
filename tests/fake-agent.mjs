#!/usr/bin/env node
// Fake ACP agent for tests and local UI development. Deterministic, no AI.
// Per prompt: streams a message (echoing prompt + SPECIFY_FEATURE_DIRECTORY), a tool call, a plan,
// asks permission to write `fake.md`; if allowed and a feature dir is set, writes it there.
// Prompts containing "slow" wait 5 s (cancellable). FAKE_REQUIRE_AUTH=1 refuses sessions until `authenticate`.
// Offers a model (fake-fast, fake-smart) and an effort (low, high) config option like claude-agent-acp.
// Supports http MCP servers (not sse) and names the session's MCP servers in each reply.
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms, signal) =>
  new Promise((res, rej) => {
    const t = setTimeout(res, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(new Error('aborted'))))
  })

let cwd = process.cwd()
let mcp = []
let abort
let authed = process.env.FAKE_REQUIRE_AUTH ? null : 'none'
const config = { model: 'fake-fast', effort: 'low' }
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: config.model, options: [{ value: 'fake-fast', name: 'Fake Fast' }, { value: 'fake-smart', name: 'Fake Smart' }] },
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: config.effort, options: [{ group: 'all', name: 'All', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }] }
]
const authMethods = process.env.FAKE_REQUIRE_AUTH
  ? [{ id: 'api-key', name: 'API key' }, { id: 'oauth-personal', name: 'Google account' }]
  : []

new AgentSideConnection(
  (conn) => ({
    initialize: async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods }),
    authenticate: async ({ methodId }) => ((authed = methodId), {}),
    newSession: async (p) => {
      if (!authed) throw RequestError.authRequired()
      cwd = p.cwd
      mcp = p.mcpServers
      return { sessionId: 'fake-session', configOptions: configOptions() }
    },
    setSessionConfigOption: async ({ configId, value }) => {
      if (!configOptions().some((o) => o.id === configId)) throw RequestError.invalidParams()
      config[configId] = value
      return { configOptions: configOptions() }
    },
    cancel: async () => abort?.abort(),
    prompt: async ({ sessionId, prompt }) => {
      abort = new AbortController()
      const text = prompt.map((b) => b.text ?? '').join('')
      const say = (sessionUpdate, t) => conn.sessionUpdate({ sessionId, update: { sessionUpdate, content: { type: 'text', text: t } } })
      const dir = process.env.SPECIFY_FEATURE_DIRECTORY
      if (text.startsWith('Optimize the agent configuration')) {
        const m = text.match(/Files:\s*\n-\s*([^\n]+)/)
        const targetPath = m ? m[1].trim() : 'CLAUDE.md'
        await conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: `Read ${targetPath}`, kind: 'read', status: 'completed' } })
        const res = await conn.requestPermission({
          sessionId,
          toolCall: { toolCallId: 't2', title: `Edit ${targetPath}`, kind: 'edit', status: 'pending' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
          ]
        })
        const allowed = res.outcome.outcome === 'selected' && res.outcome.optionId === 'allow'
        if (allowed && targetPath) {
          appendFileSync(join(cwd, targetPath), '\n<!-- optimized -->\n')
        }
        await say('agent_message_chunk', allowed ? `Optimized ${targetPath}.` : 'Skipped optimizing.')
        return { stopReason: 'end_turn' }
      }
      if (/clarify/.test(text)) {
        await say('agent_message_chunk', '## Question 1: Auth\n\n**Recommended:** Option B - fits SSO.\n\n| Option | Description |\n|---|---|\n| A | Email/password |\n| B | OAuth via Google |\n\nReply with a letter or "yes".')
        return { stopReason: 'end_turn' }
      }
      if (/analyze/.test(text)) {
        await say('agent_message_chunk', '## Specification Analysis Report\n\n| ID | Category | Severity | Location(s) | Summary | Recommendation |\n|---|---|---|---|---|---|\n| C1 | Constitution | CRITICAL | plan.md | Violates V | Simplify |\n| A1 | Ambiguity | LOW | spec.md | vague | clarify |')
        return { stopReason: 'end_turn' }
      }
      await say('agent_thought_chunk', 'Thinking about it.')
      await say('agent_message_chunk', `Received: ${text.split('\n')[0]}`)
      await say('agent_message_chunk', `\n\nFeature dir: ${dir ?? 'none'}`)
      await say('agent_message_chunk', `\n\nModel: ${config.model}, effort: ${config.effort}`)
      await say('agent_message_chunk', `\n\nMCP: ${mcp.map((s) => `${s.name}(${s.type ?? s.command})`).join(', ') || 'none'}`)
      if (authed !== 'none') await say('agent_message_chunk', `\n\nAuth: ${authed}`)
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read spec.md', kind: 'read', status: 'in_progress' } })
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'plan', entries: [{ content: 'Read spec', priority: 'high', status: 'completed' }, { content: 'Write file', priority: 'high', status: 'in_progress' }] } })
      try {
        if (text.includes('slow')) await sleep(5000, abort.signal)
      } catch {
        return { stopReason: 'cancelled' }
      }
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } })
      const res = await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: 't2', title: 'Write fake.md', kind: 'edit', status: 'pending' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
        ]
      })
      const allowed = res.outcome.outcome === 'selected' && res.outcome.optionId === 'allow'
      if (allowed && dir) {
        mkdirSync(join(cwd, dir), { recursive: true })
        writeFileSync(join(cwd, dir, 'fake.md'), `# Fake\n\n${text}\n`)
      }
      await say('agent_message_chunk', allowed ? '\n\nDone.' : '\n\nSkipped writing.')
      return { stopReason: 'end_turn' }
    }
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
)
