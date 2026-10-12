import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planInstall, platformKey, type RegistryEntry } from '../src/main/registry.ts'

const antigravity: RegistryEntry = {
  id: 'antigravity-acp',
  name: 'Google Antigravity',
  version: '1.3.0',
  distribution: {
    binary: {
      'darwin-aarch64': { archive: 'https://dl.google.com/x-darwin-arm64.zip', cmd: './agy_acp_server.par' },
      'linux-x86_64': { archive: 'https://dl.google.com/x-linux.zip', cmd: './agy_acp_server.par', args: ['--uid='] }
    }
  }
}

test('platform keys follow the registry naming', () => {
  assert.equal(platformKey('darwin', 'arm64'), 'darwin-aarch64')
  assert.equal(platformKey('win32', 'x64'), 'windows-x86_64')
  assert.equal(platformKey('linux', 'x64'), 'linux-x86_64')
})

test('npx distributions become an npx agent', () => {
  const plan = planInstall({ id: 'claude-acp', name: 'Claude Agent', version: '0.89.0', distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@0.89.0' } } }, 'darwin-aarch64')
  assert.deepEqual(plan, {
    kind: 'npx',
    agent: { id: 'claude-acp', name: 'Claude Agent', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.89.0'], env: {} }
  })
})

test('binary distributions pick the platform target or fail clearly', () => {
  const plan = planInstall(antigravity, 'linux-x86_64')
  assert.equal(plan.kind, 'binary')
  assert.deepEqual(plan.kind === 'binary' && plan.target.args, ['--uid='])
  assert.throws(() => planInstall(antigravity, 'windows-aarch64'), /no distribution for windows-aarch64/)
})
