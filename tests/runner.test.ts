import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeAgent, startAgent } from '../src/main/runner.ts'
import type { AcpUpdate } from '../src/shared/types.ts'

const fake = { id: 'fake', name: 'Fake', command: process.execPath, args: [join(import.meta.dirname, 'fake-agent.mjs')], env: {} }

test('runs a turn: updates, permission, file write in feature dir', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'studio-'))
  const updates: AcpUpdate[] = []
  const asked: string[] = []
  const session = await startAgent(fake, cwd, { SPECIFY_FEATURE_DIRECTORY: 'specs/001-x' }, {
    onUpdate: (u) => void updates.push(u),
    onPermission: async (p) => (asked.push(p.title), 'allow'),
    onExit: () => {}
  })
  const stop = await session.prompt('/speckit-plan\n\nTarget feature directory: specs/001-x')
  session.close()
  assert.equal(stop, 'end_turn')
  assert.deepEqual(asked, ['Write fake.md'])
  const text = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content?.text).join('')
  assert.match(text, /Received: \/speckit-plan/)
  assert.match(text, /Feature dir: specs\/001-x/)
  assert.ok(updates.some((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed'))
  assert.match(readFileSync(join(cwd, 'specs/001-x/fake.md'), 'utf8'), /speckit-plan/)
})

test('rejected permission writes nothing; follow-up prompt works in same session', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'studio-'))
  const session = await startAgent(fake, cwd, { SPECIFY_FEATURE_DIRECTORY: 'specs/002-y' }, {
    onUpdate: () => {},
    onPermission: async () => 'reject',
    onExit: () => {}
  })
  assert.equal(await session.prompt('first'), 'end_turn')
  assert.equal(await session.prompt('second'), 'end_turn')
  session.close()
  assert.equal(existsSync(join(cwd, 'specs/002-y/fake.md')), false)
})

test('cancel stops a running turn', async () => {
  const session = await startAgent(fake, tmpdir(), {}, { onUpdate: () => {}, onPermission: async () => null, onExit: () => {} })
  const turn = session.prompt('slow please')
  setTimeout(() => session.cancel(), 100)
  assert.equal(await turn, 'cancelled')
  session.close()
})

test('missing binary rejects with a readable error', async () => {
  await assert.rejects(
    startAgent({ ...fake, command: '/nope/agent' }, tmpdir(), {}, { onUpdate: () => {}, onPermission: async () => null, onExit: () => {} }),
    /ENOENT|nope/
  )
})

test('signs in via the oauth method when the agent requires auth, then continues', async () => {
  const notices: string[] = []
  const updates: AcpUpdate[] = []
  const session = await startAgent({ ...fake, env: { FAKE_REQUIRE_AUTH: '1' } }, tmpdir(), {}, {
    onUpdate: (u) => void updates.push(u),
    onPermission: async () => null,
    onExit: () => {},
    onNotice: (t) => void notices.push(t)
  })
  await session.prompt('hello')
  session.close()
  assert.match(notices[0], /Signing in via Google account/)
  assert.match(updates.map((u) => u.content?.text ?? '').join(''), /Auth: oauth-personal/)
})

test('sets model and effort via session/set_config_option; probe lists what the agent offers', async () => {
  const updates: AcpUpdate[] = []
  const session = await startAgent(fake, tmpdir(), {}, { onUpdate: (u) => void updates.push(u), onPermission: async () => 'reject', onExit: () => {} }, { model: 'fake-smart', effort: 'high' })
  assert.equal(session.options.model, 'fake-smart')
  assert.equal(session.options.effort, 'high')
  await session.prompt('hello')
  session.close()
  assert.match(updates.map((u) => u.content?.text ?? '').join(''), /Model: fake-smart, effort: high/)

  const options = await probeAgent(fake, tmpdir())
  assert.deepEqual(options.models.map((m) => m.value), ['fake-fast', 'fake-smart'])
  assert.deepEqual(options.efforts.map((m) => m.value), ['low', 'high'])
  assert.equal(options.model, 'fake-fast')
})
