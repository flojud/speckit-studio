import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import type { Finding, FindingRule, McpServerConfig, McpState, McpTransportType } from '../shared/types.ts'
import { onPath } from './env.ts'

/** Project MCP servers, the format Claude Code and most other tools read. */
export const MCP_FILE = '.mcp.json'
const NAME = /^[\w-]+$/
/** Fields the form edits; any other property of a server entry is kept as is. */
const FIELDS = ['type', 'command', 'args', 'env', 'url', 'headers', 'disabled']

type Entry = Record<string, unknown>
type Raw = Record<string, unknown> & { mcpServers?: Record<string, Entry> }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const strings = (v: unknown): Record<string, string> | undefined => (isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) : undefined)

function readRaw(root: string): { raw?: Raw; text?: string; error?: string } {
  const file = join(root, MCP_FILE)
  if (!existsSync(file)) return {}
  const text = readFileSync(file, 'utf8')
  try {
    const raw = JSON.parse(text)
    if (!isObject(raw)) return { text, error: 'The file must hold a JSON object' }
    if (raw.mcpServers !== undefined && !isObject(raw.mcpServers)) return { text, error: '"mcpServers" must be an object' }
    return { raw: raw as Raw, text }
  } catch (e) {
    return { text, error: (e as Error).message }
  }
}

/** stdio unless the entry says sse/http or only has a URL. */
export const transport = (s: Pick<McpServerConfig, 'type' | 'command' | 'url'>): McpTransportType =>
  s.type === 'sse' || s.type === 'http' ? s.type : !s.type && s.url && !s.command ? 'http' : 'stdio'

function toServer(name: string, e: unknown): McpServerConfig {
  if (!isObject(e)) return { name }
  const type = e.type === 'stdio' || e.type === 'sse' || e.type === 'http' ? e.type : undefined
  return {
    name,
    ...(type ? { type } : {}),
    ...(typeof e.command === 'string' ? { command: e.command } : {}),
    ...(Array.isArray(e.args) ? { args: e.args.map(String) } : {}),
    ...(strings(e.env) ? { env: strings(e.env) } : {}),
    ...(typeof e.url === 'string' ? { url: e.url } : {}),
    ...(strings(e.headers) ? { headers: strings(e.headers) } : {}),
    ...(e.disabled === true ? { disabled: true } : {})
  }
}

/** Servers of `.mcp.json`; a missing file is an empty list, a broken one reports `error` instead of throwing. */
export function readMcpConfig(root: string): McpState {
  const { raw, text, error } = readRaw(root)
  if (error) return { servers: [], exists: true, error }
  return { servers: Object.entries(raw?.mcpServers ?? {}).map(([n, e]) => toServer(n, e)), exists: text !== undefined }
}

/** What makes a server unusable, or undefined. */
export function serverProblem(s: McpServerConfig): { rule: FindingRule; reason: string; fix: string } | undefined {
  if (!NAME.test(s.name)) return { rule: 'mcp-invalid-name', reason: `"${s.name}" is not a valid server name.`, fix: 'Use letters, digits, - and _ only.' }
  if (transport(s) === 'stdio') {
    if (!s.command?.trim()) return { rule: 'mcp-missing-command', reason: `"${s.name}" has no command.`, fix: 'Set the executable that starts the server, e.g. npx or uvx.' }
  } else if (!/^https?:\/\/\S+$/.test(s.url ?? '')) return { rule: 'mcp-missing-url', reason: `"${s.name}" needs an http:// or https:// URL.`, fix: 'Set the URL of the server endpoint.' }
  return undefined
}

/** Reads, changes and writes `mcpServers` (2-space JSON, other top-level keys kept). Refuses broken JSON and symlinks. */
function update(root: string, fn: (servers: Record<string, Entry>) => Record<string, Entry>): void {
  const file = join(root, MCP_FILE)
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(`Not writable: ${MCP_FILE} is a symlink`)
  const { raw, error } = readRaw(root)
  if (error) throw new Error(`${MCP_FILE} has a syntax error – fix the JSON first: ${error}`)
  writeFileSync(file, `${JSON.stringify({ ...raw, mcpServers: fn({ ...raw?.mcpServers }) }, null, 2)}\n`)
}

const known = (name: string, servers: Record<string, Entry>): Entry => {
  if (!Object.hasOwn(servers, name)) throw new Error(`Unknown MCP server "${name}"`)
  return servers[name]
}

/** Adds a server, or updates (and renames, in place) `oldName`. Unknown properties of the entry survive. */
export function saveMcpServer(root: string, s: McpServerConfig, oldName?: string): void {
  const problem = serverProblem(s)
  if (problem) throw new Error(problem.reason)
  update(root, (servers) => {
    if (s.name !== oldName && Object.hasOwn(servers, s.name)) throw new Error(`An MCP server "${s.name}" already exists`)
    const prev = oldName ? known(oldName, servers) : {}
    const t = transport(s)
    const has = (o?: object): boolean => !!o && Object.keys(o).length > 0
    const entry: Entry = {
      // stdio needs no type; keep an explicit one so an untouched file doesn't churn
      ...(t !== 'stdio' || prev.type === 'stdio' ? { type: t } : {}),
      ...(t === 'stdio'
        ? { command: s.command!.trim(), ...(s.args?.length ? { args: s.args } : {}), ...(has(s.env) ? { env: s.env } : {}) }
        : { url: s.url!.trim(), ...(has(s.headers) ? { headers: s.headers } : {}) }),
      ...Object.fromEntries(Object.entries(prev).filter(([k]) => !FIELDS.includes(k))),
      ...(s.disabled ? { disabled: true } : {})
    }
    return oldName ? Object.fromEntries(Object.entries(servers).map(([k, v]) => (k === oldName ? [s.name, entry] : [k, v]))) : { ...servers, [s.name]: entry }
  })
}

/** `disabled: true` when off; the key is dropped when on. Nothing else changes. */
export function toggleMcpServer(root: string, name: string, enabled: boolean): void {
  update(root, (servers) => {
    const { disabled: _, ...rest } = known(name, servers)
    return { ...servers, [name]: enabled ? rest : { ...rest, disabled: true } }
  })
}

export function deleteMcpServer(root: string, name: string): void {
  update(root, (servers) => {
    known(name, servers)
    delete servers[name]
    return servers
  })
}

const pairs = (r?: Record<string, string>): { name: string; value: string }[] => Object.entries(r ?? {}).map(([name, value]) => ({ name, value }))

/** Enabled, usable servers in ACP `session/new` form. */
export const toAcpMcpServers = (servers: McpServerConfig[]): McpServer[] =>
  servers.flatMap((s): McpServer[] => {
    if (s.disabled || serverProblem(s)) return []
    const t = transport(s)
    return t === 'stdio' ? [{ name: s.name, command: s.command!, args: s.args ?? [], env: pairs(s.env) }] : [{ type: t, name: s.name, url: s.url!, headers: pairs(s.headers) }]
  })

/** Local checks of `.mcp.json`: syntax, names, required fields, duplicates, commands on PATH. */
export function validateMcpConfig(root: string): Finding[] {
  const { servers, error } = readMcpConfig(root)
  const base = { file: MCP_FILE }
  if (error) return [{ ...base, rule: 'mcp-syntax-error', severity: 'error', reason: `${MCP_FILE} is not valid: ${error}`, fix: 'Fix the JSON (Edit JSON), then save.' }]
  const text = servers.length ? readFileSync(join(root, MCP_FILE), 'utf8') : ''
  const key = (n: string): RegExp => new RegExp(`${JSON.stringify(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*\\{`, 'g')
  return servers.flatMap((s): Finding[] => {
    const at = text.search(key(s.name))
    const where = { ...base, server: s.name, ...(at >= 0 ? { line: text.slice(0, at).split('\n').length } : {}) }
    const out: Finding[] = []
    const p = serverProblem(s)
    if (p) out.push({ ...where, ...p, severity: 'error' })
    else if (transport(s) === 'stdio' && !onPath(s.command!, root))
      out.push({ ...where, rule: 'mcp-missing-binary', severity: 'warning', reason: `"${s.command}" was not found on PATH – "${s.name}" can't start.`, fix: 'Install it, or use the full path to the executable.' })
    // ponytail: JSON.parse keeps only the last duplicate key, so count the key in the raw text; a JSON tokenizer if this misfires
    if ((text.match(key(s.name))?.length ?? 0) > 1)
      out.push({ ...where, rule: 'mcp-duplicate-name', severity: 'error', reason: `"${s.name}" is declared more than once – only the last one is used.`, fix: 'Rename or remove the other entries.' })
    return out
  })
}
