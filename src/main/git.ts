import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Spec } from '../shared/types.ts'

const run = async (cmd: string, args: string[], cwd: string): Promise<string> =>
  (await promisify(execFile)(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim()
export const git = (cwd: string, ...args: string[]): Promise<string> => run('git', args, cwd)
export const tryGit = (cwd: string, ...args: string[]): Promise<string | undefined> => git(cwd, ...args).catch(() => undefined)

export const WORKTREES = '.studio/worktrees'

export interface GitInfo {
  isRepo: boolean
  defaultBranch?: string
  branches: string[]
  /** Branches merged into the default branch. */
  merged: string[]
  /** Spec keys that have a studio worktree. */
  worktrees: string[]
}

export async function gitInfo(repo: string): Promise<GitInfo> {
  if ((await tryGit(repo, 'rev-parse', '--is-inside-work-tree')) !== 'true') return { isRepo: false, branches: [], merged: [], worktrees: [] }
  const branches = ((await tryGit(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')) ?? '').split('\n').filter(Boolean)
  const remoteHead = (await tryGit(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'))?.replace(/^origin\//, '')
  const defaultBranch = remoteHead ?? ['main', 'master'].find((b) => branches.includes(b)) ?? (await tryGit(repo, 'branch', '--show-current'))
  const merged = defaultBranch ? ((await tryGit(repo, 'branch', '--format=%(refname:short)', '--merged', defaultBranch)) ?? '').split('\n').filter(Boolean) : []
  const porcelain = (await tryGit(repo, 'worktree', 'list', '--porcelain')) ?? ''
  const root = resolve(realpathSync(repo), WORKTREES) // git reports real paths (macOS: /var → /private/var)
  const worktrees = [...porcelain.matchAll(/^worktree (.+)$/gm)].map((m) => m[1]).filter((p) => p.startsWith(`${root}/`)).map((p) => p.slice(root.length + 1))
  return { isRepo: true, defaultBranch, branches, merged, worktrees }
}

/**
 * Adds branch/worktree state to specs (mutates). A spec whose tasks are all done is only Done once its branch
 * (if it has one) is merged into the default branch.
 */
export function applyGit(specs: Spec[], info: GitInfo): void {
  if (!info.isRepo) return
  for (const s of specs) {
    const hasBranch = info.branches.includes(s.key) && s.key !== info.defaultBranch
    const state = !hasBranch ? 'none' : info.merged.includes(s.key) ? 'merged' : 'branch'
    s.git = { state, worktree: info.worktrees.includes(s.key) }
    if (s.phase === 'done' && state === 'branch') s.phase = 'implementing'
  }
}

/**
 * Names that may carry a spec number: local and remote-tracking branches (remote prefix stripped) and spec folders
 * in studio worktrees. Local refs only – no fetch, so branches pushed elsewhere since the last fetch are missed.
 */
export async function specRefNames(repo: string): Promise<string[]> {
  const refs = (await tryGit(repo, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads')) ?? ''
  const remotes = (await tryGit(repo, 'for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes')) ?? ''
  const wt = resolve(repo, WORKTREES)
  const inWorktrees = existsSync(wt) ? readdirSync(wt).flatMap((k) => (existsSync(join(wt, k, 'specs')) ? readdirSync(join(wt, k, 'specs')) : [])) : []
  return [...`${refs}\n${remotes}`.split('\n').filter((n) => n && n !== 'HEAD'), ...inWorktrees]
}

/** Checks out branch `key` in the main tree (created from HEAD if missing). Returns false for non-git folders. */
export async function ensureBranch(repo: string, key: string): Promise<boolean> {
  if ((await tryGit(repo, 'rev-parse', '--is-inside-work-tree')) !== 'true') return false
  const exists = (await tryGit(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${key}`)) !== undefined
  await (exists ? git(repo, 'switch', key) : git(repo, 'switch', '-c', key))
  return true
}

/** Keeps `.studio/` out of git without touching the user's .gitignore. */
async function excludeStudio(repo: string): Promise<void> {
  const file = join(resolve(repo, await git(repo, 'rev-parse', '--git-common-dir')), 'info', 'exclude')
  if (!existsSync(file) || !readFileSync(file, 'utf8').split('\n').includes('.studio/')) appendFileSync(file, '\n.studio/\n')
}

/** Creates (or reuses) the worktree for a spec branch; creates the branch from HEAD if missing. Returns its path. */
export async function addWorktree(repo: string, key: string): Promise<string> {
  const path = resolve(repo, WORKTREES, key)
  if (existsSync(path)) return path
  await excludeStudio(repo)
  const branches = (await git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).split('\n')
  if ((await git(repo, 'branch', '--show-current')) === key) throw new Error(`Branch ${key} is checked out in the main working tree – switch branches first.`)
  await (branches.includes(key) ? git(repo, 'worktree', 'add', path, key) : git(repo, 'worktree', 'add', '-b', key, path))
  return path
}

export async function removeWorktree(repo: string, key: string): Promise<void> {
  const path = resolve(repo, WORKTREES, key)
  if (await git(path, 'status', '--porcelain')) throw new Error(`The worktree of ${key} has uncommitted changes – commit (or discard) them first.`)
  await git(repo, 'worktree', 'remove', path)
}

/** Opens a PR for the spec branch with GitHub's CLI; returns the PR URL. */
export async function createPr(repo: string, key: string): Promise<string> {
  await git(repo, 'push', '-u', 'origin', key)
  return run('gh', ['pr', 'create', '--head', key, '--fill'], repo)
}
