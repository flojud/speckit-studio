import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteMcpServer, readMcpConfig, saveMcpServer, toAcpMcpServers, toggleMcpServer, validateMcpConfig } from '../src/main/mcp.ts'

const repo = (json?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
  if (json !== undefined) writeFileSync(join(dir, '.mcp.json'), json)
  return dir
}
const raw = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))

const SAMPLE = JSON.stringify({
  $schema: 'x',
  mcpServers: {
    sqlite: { command: 'uvx', args: ['mcp-server-sqlite', '--db-path', 'app.db'], env: { DEBUG: 'true' }, timeout: 30 },
    docs: { type: 'sse', url: 'https://mcp.example/sse', headers: { Authorization: 'Bearer t' }, disabled: true },
    remote: { url: 'https://mcp.example/http' }
  }
})

test('readMcpConfig: missing file, servers, syntax error', () => {
  assert.deepEqual(readMcpConfig(repo()), { servers: [], exists: false })
  const { servers, exists } = readMcpConfig(repo(SAMPLE))
  assert.equal(exists, true)
  assert.deepEqual(servers, [
    { name: 'sqlite', command: 'uvx', args: ['mcp-server-sqlite', '--db-path', 'app.db'], env: { DEBUG: 'true' } },
    { name: 'docs', type: 'sse', url: 'https://mcp.example/sse', headers: { Authorization: 'Bearer t' }, disabled: true },
    { name: 'remote', url: 'https://mcp.example/http' }
  ])
  const broken = readMcpConfig(repo('{ "mcpServers": { '))
  assert.equal(broken.exists, true)
  assert.deepEqual(broken.servers, [])
  assert.ok(broken.error)
})

test('toAcpMcpServers maps stdio/sse/http and omits disabled and incomplete servers', () => {
  const { servers } = readMcpConfig(repo(SAMPLE))
  assert.deepEqual(toAcpMcpServers([...servers, { name: 'nocmd' }]), [
    { name: 'sqlite', command: 'uvx', args: ['mcp-server-sqlite', '--db-path', 'app.db'], env: [{ name: 'DEBUG', value: 'true' }] },
    { type: 'http', name: 'remote', url: 'https://mcp.example/http', headers: [] }
  ])
  assert.deepEqual(toAcpMcpServers([{ name: 'd', type: 'sse', url: 'http://x/sse', headers: { A: 'b' } }]), [
    { type: 'sse', name: 'd', url: 'http://x/sse', headers: [{ name: 'A', value: 'b' }] }
  ])
})

test('saveMcpServer creates the file, appends, edits, renames in place and keeps unknown keys', () => {
  const dir = repo()
  saveMcpServer(dir, { name: 'fs', command: 'npx', args: ['-y', 'server-fs'] })
  assert.deepEqual(raw(dir), { mcpServers: { fs: { command: 'npx', args: ['-y', 'server-fs'] } } })
  assert.throws(() => saveMcpServer(dir, { name: 'fs', command: 'x' }), /already exists/)
  assert.throws(() => saveMcpServer(dir, { name: 'bad name', command: 'x' }), /not a valid/)
  assert.throws(() => saveMcpServer(dir, { name: 'n', type: 'http', url: 'ftp://x' }), /URL/)

  const d2 = repo(SAMPLE)
  saveMcpServer(d2, { name: 'db', command: 'uvx', args: ['other'] }, 'sqlite')
  const after = raw(d2) as { $schema: string; mcpServers: Record<string, unknown> }
  assert.equal(after.$schema, 'x')
  assert.deepEqual(Object.keys(after.mcpServers), ['db', 'docs', 'remote'])
  assert.deepEqual(after.mcpServers.db, { command: 'uvx', args: ['other'], timeout: 30 })
  // switching transport drops the old transport's fields
  saveMcpServer(d2, { name: 'db', type: 'http', url: 'https://h' }, 'db')
  assert.deepEqual(after.mcpServers.docs, (raw(d2) as typeof after).mcpServers.docs)
  assert.deepEqual((raw(d2) as typeof after).mcpServers.db, { type: 'http', url: 'https://h', timeout: 30 })
  assert.throws(() => saveMcpServer(d2, { name: 'docs', command: 'x' }, 'db'), /already exists/)
  assert.throws(() => saveMcpServer(d2, { name: 'zz', command: 'x' }, 'nope'), /Unknown/)
})

test('toggleMcpServer flips only disabled; deleteMcpServer keeps an empty mcpServers', () => {
  const dir = repo(SAMPLE)
  toggleMcpServer(dir, 'sqlite', false)
  toggleMcpServer(dir, 'docs', true)
  const s = (raw(dir) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers
  assert.deepEqual(s.sqlite, { command: 'uvx', args: ['mcp-server-sqlite', '--db-path', 'app.db'], env: { DEBUG: 'true' }, timeout: 30, disabled: true })
  assert.equal('disabled' in s.docs, false)
  assert.throws(() => toggleMcpServer(dir, 'nope', true), /Unknown/)
  for (const n of ['sqlite', 'docs', 'remote']) deleteMcpServer(dir, n)
  assert.deepEqual(raw(dir), { $schema: 'x', mcpServers: {} })
})

test('writes refuse broken JSON and a symlinked .mcp.json', () => {
  assert.throws(() => toggleMcpServer(repo('{'), 'x', true), /syntax error/)
  const dir = repo()
  const outside = join(repo(SAMPLE), '.mcp.json')
  symlinkSync(outside, join(dir, '.mcp.json'))
  assert.throws(() => deleteMcpServer(dir, 'sqlite'), /symlink/)
})

test('validateMcpConfig: syntax, missing command/url, invalid name, duplicates, binary not on PATH', () => {
  assert.deepEqual(validateMcpConfig(repo()), [])
  assert.deepEqual(validateMcpConfig(repo('{ nope')).map((f) => f.rule), ['mcp-syntax-error'])
  const dir = repo(`{
  "mcpServers": {
    "ok": { "command": "node" },
    "gone": { "command": "definitely-not-a-binary-xyz" },
    "nocmd": { "args": ["x"] },
    "web": { "type": "http" },
    "bad name": { "command": "node" },
    "dup": { "command": "node" },
    "dup": { "command": "node" }
  }
}`)
  const byServer = validateMcpConfig(dir).map((f) => `${f.server}:${f.rule}:${f.severity}`)
  assert.deepEqual(byServer, [
    'gone:mcp-missing-binary:warning',
    'nocmd:mcp-missing-command:error',
    'web:mcp-missing-url:error',
    'bad name:mcp-invalid-name:error',
    'dup:mcp-duplicate-name:error'
  ])
  assert.equal(validateMcpConfig(dir).find((f) => f.server === 'gone')?.line, 4)
})
