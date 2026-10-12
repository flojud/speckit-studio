import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { AgentConfig } from '../shared/types.ts'

const REGISTRY = 'https://raw.githubusercontent.com/agentclientprotocol/registry/main'

interface Target {
  archive: string
  cmd: string
  args?: string[]
  env?: Record<string, string>
}

export interface RegistryEntry {
  id: string
  name: string
  version: string
  distribution: {
    npx?: { package: string; args?: string[]; env?: Record<string, string> }
    binary?: Record<string, Target>
  }
}

/** Registry platform key, e.g. `darwin-aarch64`. */
export const platformKey = (platform: string = process.platform, arch: string = process.arch): string =>
  `${platform === 'win32' ? 'windows' : platform}-${arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch}`

export type InstallPlan = { kind: 'npx'; agent: AgentConfig } | { kind: 'binary'; target: Target }

/** Chooses how to run a registry agent on this platform. Prefers npx (nothing to download). */
export function planInstall(entry: RegistryEntry, platform: string): InstallPlan {
  const { npx, binary } = entry.distribution
  if (npx)
    return { kind: 'npx', agent: { id: entry.id, name: entry.name, command: 'npx', args: ['-y', npx.package, ...(npx.args ?? [])], env: npx.env ?? {} } }
  const target = binary?.[platform]
  if (target) return { kind: 'binary', target }
  throw new Error(`${entry.name} has no distribution for ${platform}`)
}

/** Downloads and configures a registry agent. Network access only happens here, on explicit user action. */
export async function installAgent(id: string, dataDir: string): Promise<AgentConfig> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Invalid registry id: ${id}`)
  const res = await fetch(`${REGISTRY}/${id}/agent.json`)
  if (!res.ok) throw new Error(`Registry has no agent "${id}" (HTTP ${res.status})`)
  const entry = (await res.json()) as RegistryEntry
  const plan = planInstall(entry, platformKey())
  if (plan.kind === 'npx') return plan.agent

  const dir = join(dataDir, 'agents', id, entry.version)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const zip = join(dir, 'agent.zip')
  const archive = await fetch(plan.target.archive)
  if (!archive.ok) throw new Error(`Download failed (HTTP ${archive.status})`)
  writeFileSync(zip, Buffer.from(await archive.arrayBuffer()))
  // ponytail: relies on `unzip` (macOS/Linux); Windows needs tar.exe or a zip library.
  await promisify(execFile)('unzip', ['-o', '-q', zip, '-d', dir])
  rmSync(zip)
  const command = resolve(dir, plan.target.cmd)
  chmodSync(command, 0o755)
  return { id, name: entry.name, command, args: plan.target.args ?? [], env: plan.target.env ?? {} }
}
