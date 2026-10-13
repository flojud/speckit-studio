import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyDangerousPermissions, autoAnswer, foldEvents, isDangerousPermissionsSupported, pickConfig, resolveEffectiveConfig, runPrompt, withInstructions, workItemPrompt } from '../src/shared/runs.ts'
import { ensureBranch } from '../src/main/git.ts'
import { draftMarkdown, readProject } from '../src/main/speckit.ts'
import type { RunEvent } from '../src/shared/types.ts'

const chunk = (sessionUpdate: string, text: string): RunEvent => ({ type: 'update', update: { sessionUpdate, content: { type: 'text', text } } })

test('merges consecutive chunks of the same role', () => {
  const r = foldEvents([chunk('agent_message_chunk', 'Hel'), chunk('agent_message_chunk', 'lo'), chunk('agent_thought_chunk', 'hm'), chunk('agent_message_chunk', '!')])
  assert.deepEqual(r.items, [
    { kind: 'message', role: 'agent', text: 'Hello' },
    { kind: 'message', role: 'thought', text: 'hm' },
    { kind: 'message', role: 'agent', text: '!' }
  ])
})

test('updates tool calls in place and keeps the latest plan', () => {
  const r = foldEvents([
    { type: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read spec.md', kind: 'read', status: 'pending' } },
    { type: 'update', update: { sessionUpdate: 'plan', entries: [{ content: 'a', status: 'pending' }] } },
    { type: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } },
    { type: 'update', update: { sessionUpdate: 'plan', entries: [{ content: 'a', status: 'completed' }] } }
  ])
  assert.deepEqual(r.items, [{ kind: 'tool', id: 't1', title: 'Read spec.md', toolKind: 'read', status: 'completed' }])
  assert.deepEqual(r.plan, [{ content: 'a', status: 'completed' }])
})

test('tracks pending permission, user replies and status', () => {
  const opts = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
  const asked = foldEvents([{ type: 'permission', requestId: 'p1', title: 'Write plan.md', options: opts }])
  assert.equal(asked.permission?.title, 'Write plan.md')
  const r = foldEvents([
    { type: 'permission', requestId: 'p1', title: 'Write plan.md', options: opts },
    { type: 'answer', requestId: 'p1', optionId: 'allow' },
    { type: 'status', status: 'waiting' },
    { type: 'user', text: 'Option B' },
    { type: 'status', status: 'failed', error: 'boom' }
  ])
  assert.equal(r.permission, undefined)
  assert.deepEqual(r.items, [{ kind: 'message', role: 'user', text: 'Option B' }])
  assert.equal(r.status, 'failed')
  assert.equal(r.error, 'boom')
})

test('foldEvents ignores the optimize baseline event', () => {
  const r = foldEvents([{ type: 'baseline', files: { 'CLAUDE.md': 'x', 'GEMINI.md': null } }, { type: 'user', text: 'Optimize' }])
  assert.deepEqual(r.items, [{ kind: 'message', role: 'user', text: 'Optimize' }])
})

test('foldEvents parses active configuration notice into activeConfig', () => {
  const r = foldEvents([
    { type: 'notice', text: 'Active configuration: Claude Code · model: sonnet · effort: low' }
  ])
  assert.deepEqual(r.activeConfig, { model: 'sonnet', effort: 'low' })
})

test('autoAnswer approves only read-only calls, only when enabled', () => {
  const opts = [
    { optionId: 'always', name: 'Always', kind: 'allow_always' },
    { optionId: 'once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' }
  ]
  assert.equal(autoAnswer('read', opts, true), 'once')
  assert.equal(autoAnswer('search', opts.slice(0, 1), true), 'always')
  assert.equal(autoAnswer('edit', opts, true), null)
  assert.equal(autoAnswer('execute', opts, true), null)
  assert.equal(autoAnswer('read', opts, false), null)
  assert.equal(autoAnswer(undefined, opts, true), null)
})

test('autoAnswer with dangerouslySkip auto-approves all tool calls', () => {
  const opts = [
    { optionId: 'once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'always', name: 'Always', kind: 'allow_always' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' }
  ]
  // Prefers allow_always if available
  assert.equal(autoAnswer('edit', opts, false, true), 'always')
  assert.equal(autoAnswer('execute', [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }], false, true), 'once')
  assert.equal(autoAnswer(undefined, [{ optionId: 'custom', name: 'Run', kind: 'custom' }], false, true), 'custom')
  assert.equal(autoAnswer('edit', [], false, true), null)
})

test('isDangerousPermissionsSupported detects claude and agy agents', () => {
  assert.equal(isDangerousPermissionsSupported({ id: 'claude', name: 'Claude Code', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] }), true)
  assert.equal(isDangerousPermissionsSupported({ id: 'agy', name: 'Antigravity', command: 'agy', args: [] }), true)
  assert.equal(isDangerousPermissionsSupported({ id: 'antigravity-acp', name: 'Google Antigravity', command: './agy_acp_server.par', args: [] }), false)
  assert.equal(isDangerousPermissionsSupported({ id: 'custom', name: 'My CLI', command: 'claude', args: [] }), true)
  assert.equal(isDangerousPermissionsSupported({ id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: [] }), false)
  assert.equal(isDangerousPermissionsSupported({ id: 'codex', name: 'Codex', command: 'codex', args: [] }), false)
})

test('applyDangerousPermissions injects --dangerously-skip-permissions for supported agents without duplicates', () => {
  const claude = { id: 'claude', name: 'Claude Code', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] }
  const agy = { id: 'agy', name: 'Antigravity (agy)', command: 'agy', args: [] }
  const agyPar = { id: 'antigravity-acp', name: 'Google Antigravity', command: './agy_acp_server.par', args: [] }
  const gemini = { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: [] }

  // Enabled
  assert.deepEqual(applyDangerousPermissions(claude, true).args, ['-y', '@agentclientprotocol/claude-agent-acp', '--dangerously-skip-permissions'])
  assert.deepEqual(applyDangerousPermissions(agy, true).args, ['--dangerously-skip-permissions'])
  // agy_acp_server.par delegates over ACP and does not accept CLI flags
  assert.deepEqual(applyDangerousPermissions(agyPar, true).args, [])
  // Idempotent / no duplicate
  const alreadySet = { ...agy, args: ['--dangerously-skip-permissions'] }
  assert.deepEqual(applyDangerousPermissions(alreadySet, true).args, ['--dangerously-skip-permissions'])
  // Unsupported agents unaffected
  assert.deepEqual(applyDangerousPermissions(gemini, true).args, [])
  // Disabled
  assert.deepEqual(applyDangerousPermissions(claude, false).args, ['-y', '@agentclientprotocol/claude-agent-acp'])
  assert.deepEqual(applyDangerousPermissions(agy, false).args, [])
})

test('runPrompt: target dir, and the branch line only for specify on a draft', () => {
  assert.equal(runPrompt('/speckit-', 'plan', '', '001-a'), '/speckit-plan\n\nTarget feature directory: specs/001-a')
  assert.equal(runPrompt('/speckit.', 'specify', ' Albums ', null), '/speckit.specify Albums')
  assert.equal(
    runPrompt('/speckit-', 'specify', 'Share albums.', '021-y', '021-y'),
    '/speckit-specify Share albums.\n\nTarget feature directory: specs/021-y\nGit branch: 021-y (already checked out)'
  )
})

// startRun imports Electron, so this checks the pieces it composes for specify on a draft.
test('specify from a draft: description from draft.md, spec branch checked out, draft untouched', async () => {
  const sh = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
  const dir = mkdtempSync(join(tmpdir(), 'draft-run-'))
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  mkdirSync(join(dir, '.specify'))
  mkdirSync(join(dir, 'specs/021-y'), { recursive: true })
  mkdirSync(join(dir, 'specs/022-empty'), { recursive: true })
  writeFileSync(join(dir, 'specs/021-y/draft.md'), draftMarkdown('Album sharing', 'Share albums with a link.'))
  writeFileSync(join(dir, 'specs/022-empty/draft.md'), draftMarkdown('Empty', ''))
  const specs = readProject(dir).specs
  assert.equal(specs.find((s) => s.key === '022-empty')!.description, '') // startRun refuses: "Add a description to the draft first."
  const description = specs.find((s) => s.key === '021-y')!.description!
  assert.equal(await ensureBranch(dir, '021-y'), true)
  assert.equal(sh(dir, 'branch', '--show-current'), '021-y')
  const prompt = runPrompt('/speckit-', 'specify', description, '021-y', '021-y')
  assert.match(prompt, /^\/speckit-specify Share albums with a link\./)
  assert.match(prompt, /Target feature directory: specs\/021-y\nGit branch: 021-y \(already checked out\)/)
  assert.equal(readFileSync(join(dir, 'specs/021-y/draft.md'), 'utf8'), '# Album sharing\n\nShare albums with a link.\n')
})

test('hasActiveRun and cancelProjectRuns track and cancel active sessions', async () => {
  const { openDb, addProject, upsertAgent } = await import('../src/main/db.ts')
  const { startRun, hasActiveRun, cancelProjectRuns } = await import('../src/main/runs.ts')

  const dir = mkdtempSync(join(tmpdir(), 'runs-active-'))
  openDb(':memory:')
  const fake = { id: 'fake', name: 'Fake', command: process.execPath, args: [join(import.meta.dirname, 'fake-agent.mjs')], env: {} }
  upsertAgent(fake)
  const p = addProject(dir)

  assert.equal(hasActiveRun(p.id), false)

  await startRun(p.id, null, 'fake', 'specify', 'Test prompt')
  // Turn enters waiting state after fake agent runs
  assert.equal(hasActiveRun(p.id), true)
  assert.equal(hasActiveRun(p.id + 999), false)

  cancelProjectRuns(p.id)
  assert.equal(hasActiveRun(p.id), false)
})

test('pickConfig reads an ACP select option by category and flattens groups', () => {
  const opts = [
    { id: 'mode', type: 'select', category: 'mode', currentValue: 'default', options: [{ value: 'default', name: 'Manual' }] },
    { id: 'model', type: 'select', category: 'model', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus 5.5' }, { value: 'sonnet', name: 'Sonnet 5.5', description: 'fast' }] },
    { id: 'effort', type: 'select', category: 'thought_level', currentValue: 'high', options: [{ group: 'g', name: 'G', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }] }
  ]
  assert.deepEqual(pickConfig(opts, 'model'), { id: 'model', current: 'opus', choices: [{ value: 'opus', name: 'Opus 5.5' }, { value: 'sonnet', name: 'Sonnet 5.5', description: 'fast' }] })
  assert.deepEqual(pickConfig(opts, 'thought_level')?.choices.map((c) => c.value), ['low', 'high'])
  assert.equal(pickConfig(opts.slice(0, 2), 'thought_level'), undefined)
  assert.equal(pickConfig(undefined, 'model'), undefined)
})

test('resolveEffectiveConfig hierarchy: phase override -> global default -> agent fallback', () => {
  const phaseConfigs = {
    specify: { agentId: 'antigravity-acp', model: 'gemini-3.8-flash-high', effort: 'high' },
    plan: { agentId: 'claude', model: 'opus' }
  }
  const globalDefaults = { model: 'sonnet', effort: 'medium' }

  // 1. Phase with full override
  const specifyConfig = resolveEffectiveConfig('specify', phaseConfigs, globalDefaults, 'claude')
  assert.deepEqual(specifyConfig, {
    agentId: 'antigravity-acp',
    model: 'gemini-3.8-flash-high',
    effort: 'high'
  })

  // 2. Phase with partial override (model overridden, inherits global effort)
  const planConfig = resolveEffectiveConfig('plan', phaseConfigs, globalDefaults, 'claude')
  assert.deepEqual(planConfig, {
    agentId: 'claude',
    model: 'opus',
    effort: 'medium'
  })

  // 3. Phase without override (inherits global defaults and fallback agent)
  const tasksConfig = resolveEffectiveConfig('tasks', phaseConfigs, globalDefaults, 'default-agent')
  assert.deepEqual(tasksConfig, {
    agentId: 'default-agent',
    model: 'sonnet',
    effort: 'medium'
  })

  // 4. No overrides and no global defaults
  const rawConfig = resolveEffectiveConfig('implement', {}, {}, 'fallback-agent')
  assert.deepEqual(rawConfig, {
    agentId: 'fallback-agent',
    model: undefined,
    effort: undefined
  })
})

test('startRun sets model and effort over ACP and reports what the agent uses', async () => {
  const { openDb, addProject, upsertAgent, setPhaseConfigs, listRunEvents, getAgentOptions } = await import('../src/main/db.ts')
  const { startRun, cancelProjectRuns } = await import('../src/main/runs.ts')

  const dir = mkdtempSync(join(tmpdir(), 'runs-notice-'))
  openDb(':memory:')
  const fake = { id: 'fake', name: 'Fake Agent', command: process.execPath, args: [join(import.meta.dirname, 'fake-agent.mjs')], env: {} }
  upsertAgent(fake)
  const p = addProject(dir)

  setPhaseConfigs({
    specify: { agentId: 'fake', model: 'fake-smart', effort: 'high' },
    plan: { agentId: 'fake', model: 'claude-3-7-sonnet' }
  })

  const notices = async (runId: number): Promise<string[]> => {
    for (let i = 0; i < 100; i++) {
      const texts = listRunEvents(runId).flatMap((e) => (e.type === 'notice' ? [e.text] : []))
      if (texts.some((t) => t.startsWith('Active configuration:'))) return texts
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('no active configuration notice')
  }

  const runId = await startRun(p.id, null, 'fake', 'specify', 'Test prompt')
  assert.ok((await notices(runId)).includes('Active configuration: Fake Agent · model: fake-smart · effort: high'))
  assert.deepEqual(getAgentOptions('fake')?.models.map((m) => m.value), ['fake-fast', 'fake-smart'])
  cancelProjectRuns(p.id)

  // A model the agent does not offer is skipped with a notice, not passed through.
  const planRun = await startRun(p.id, null, 'fake', 'plan', '')
  const planNotices = await notices(planRun)
  assert.ok(planNotices.includes('Model "claude-3-7-sonnet" is not offered by Fake Agent, using fake-fast.'))
  assert.ok(planNotices.includes('Active configuration: Fake Agent · model: fake-fast · effort: low'))
  cancelProjectRuns(p.id)

  cancelProjectRuns(p.id)
})


test('work item runs: plain prompt with file, metadata and request; run keyed by the item, repo root as cwd', async () => {
  const prompt = workItemPrompt({ file: 'work-items/WI-001-faq.md', title: 'FAQ', category: 'wiki-doc', status: 'draft', body: '' }, ' Draft 10 questions ')
  assert.doesNotMatch(prompt, /\/speckit/)
  assert.match(prompt, /^You are working on the following product work item: work-items\/WI-001-faq\.md\n/)
  assert.match(prompt, /Title: FAQ\nCategory: wiki-doc\nStatus: draft\n\n## Current Content\n\(empty\)\n\n## User Request\nDraft 10 questions\n/)

  const { openDb, addProject, upsertAgent, listRuns } = await import('../src/main/db.ts')
  const { startRun, cancelProjectRuns, WORK_ITEM_COMMAND } = await import('../src/main/runs.ts')
  openDb(':memory:')
  upsertAgent({ id: 'fake', name: 'Fake', command: process.execPath, args: [join(import.meta.dirname, 'fake-agent.mjs')], env: {} })
  const p = addProject(mkdtempSync(join(tmpdir(), 'wi-run-')))
  await startRun(p.id, 'WI-001-faq', 'fake', WORK_ITEM_COMMAND, '', { prompt, worktree: false })
  const [run] = listRuns(p.id, 'WI-001-faq')
  assert.deepEqual([run.specKey, run.prompt], ['WI-001-faq', prompt])
  await assert.rejects(startRun(p.id, 'WI-001-faq', 'fake', WORK_ITEM_COMMAND, '', { prompt }), /already active/)
  cancelProjectRuns(p.id)
})

test('resolveEffectiveConfig: project agent and preferences sit between phase overrides and global defaults', () => {
  const project = { agentId: 'proj', preferences: { model: 'pm', effort: 'pe' } }
  const global = { model: 'gm', effort: 'ge' }
  assert.deepEqual(resolveEffectiveConfig('plan', {}, global, 'header', project), { agentId: 'proj', model: 'pm', effort: 'pe' })
  assert.deepEqual(resolveEffectiveConfig('plan', { plan: { agentId: 'phase', model: 'phm' } }, global, 'header', project), { agentId: 'phase', model: 'phm', effort: 'pe' })
  assert.deepEqual(resolveEffectiveConfig('plan', {}, global, 'header', { preferences: { effort: ' ' } }), { agentId: 'header', model: 'gm', effort: 'ge' })
  assert.equal(withInstructions('/speckit-plan', ' Use pnpm. '), '/speckit-plan\n\nProject instructions:\nUse pnpm.')
  assert.equal(withInstructions('/speckit-plan', '  '), '/speckit-plan')
})

test('startRun: project agent, preferences and instructions; enabled MCP servers reach the ACP session', async () => {
  const { openDb, addProject, upsertAgent, listRunEvents, listRuns, setProjectAgentPreferences } = await import('../src/main/db.ts')
  const { startRun, cancelProjectRuns } = await import('../src/main/runs.ts')
  openDb(':memory:')
  const fakeArgs = [join(import.meta.dirname, 'fake-agent.mjs')]
  upsertAgent({ id: 'fake', name: 'Fake', command: process.execPath, args: fakeArgs, env: {} })
  const dir = mkdtempSync(join(tmpdir(), 'runs-mcp-'))
  mkdirSync(join(dir, '.specify'))
  writeFileSync(join(dir, '.specify/integration.json'), JSON.stringify({ integration: 'claude', studio_agent: 'fake' }))
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        local: { command: 'node', args: ['server.js'], env: { A: '1' } },
        off: { command: 'node', disabled: true },
        web: { type: 'http', url: 'https://mcp.example/mcp' },
        stream: { type: 'sse', url: 'https://mcp.example/sse' }
      }
    })
  )
  const p = addProject(dir)
  setProjectAgentPreferences(p.id, { model: 'fake-smart', instructions: 'Be brief.' })

  const reply = async (runId: number): Promise<{ text: string; notices: string[] }> => {
    for (let i = 0; i < 100; i++) {
      const events = listRunEvents(runId)
      const text = events.flatMap((e) => (e.type === 'update' && e.update.sessionUpdate === 'agent_message_chunk' ? [e.update.content?.text ?? ''] : [])).join('')
      if (text.includes('MCP:')) return { text, notices: events.flatMap((e) => (e.type === 'notice' ? [e.text] : [])) }
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('no reply')
  }
  // 'claude' is the header agent; the project assigns 'fake'
  const runId = await startRun(p.id, null, 'claude', 'plan', '')
  const { text, notices } = await reply(runId)
  assert.match(text, /MCP: local\(node\), web\(http\)$/m) // disabled omitted, sse dropped (agent supports http only)
  assert.match(text, /Model: fake-smart/)
  assert.ok(notices.includes('MCP servers: local, web, stream'))
  assert.ok(notices.includes('MCP server "stream" skipped: Fake does not support sse MCP servers.'))
  const run = listRuns(p.id).find((r) => r.id === runId)!
  assert.equal(run.agent, 'fake')
  assert.match(run.prompt, /\n\nProject instructions:\nBe brief\.$/)
  cancelProjectRuns(p.id)

  // A broken .mcp.json never blocks the run
  writeFileSync(join(dir, '.mcp.json'), '{ nope')
  const broken = await reply(await startRun(p.id, null, 'claude', 'plan', ''))
  assert.match(broken.text, /MCP: none/)
  assert.ok(broken.notices.some((n) => n.startsWith('.mcp.json has a syntax error')))
  cancelProjectRuns(p.id)
})
