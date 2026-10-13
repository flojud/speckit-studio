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
  /** Where spec branches are merged: `devel`/`develop` if present, else the default branch. */
  base?: string
  branches: string[]
  /** Branches merged (also squash-merged) into the base or the default branch. */
  merged: string[]
  /** Spec keys that have a studio worktree. */
  worktrees: string[]
}

export async function gitInfo(repo: string): Promise<GitInfo> {
  if ((await tryGit(repo, 'rev-parse', '--is-inside-work-tree')) !== 'true') return { isRepo: false, branches: [], merged: [], worktrees: [] }
  const branches = ((await tryGit(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')) ?? '').split('\n').filter(Boolean)
  const remoteHead = (await tryGit(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'))?.replace(/^origin\//, '')
  const defaultBranch = remoteHead ?? ['main', 'master'].find((b) => branches.includes(b)) ?? (await tryGit(repo, 'branch', '--show-current'))
  const base = ['devel', 'develop'].find((b) => branches.includes(b)) ?? defaultBranch
  const mergedInto = async (b?: string): Promise<string[]> => (b ? ((await tryGit(repo, 'branch', '--format=%(refname:short)', '--merged', b)) ?? '').split('\n').filter(Boolean) : [])
  const merged = [...new Set([...(await mergedInto(base)), ...(await mergedInto(defaultBranch))])]
  // ponytail: a few git calls per unmerged spec branch on every snapshot; cache by branch tip if it gets slow.
  for (const b of branches) if (base && /^\d+-/.test(b) && !merged.includes(b) && (await squashMerged(repo, base, b))) merged.push(b)
  const porcelain = (await tryGit(repo, 'worktree', 'list', '--porcelain')) ?? ''
  const root = resolve(realpathSync(repo), WORKTREES) // git reports real paths (macOS: /var → /private/var)
  const worktrees = [...porcelain.matchAll(/^worktree (.+)$/gm)].map((m) => m[1]).filter((p) => p.startsWith(`${root}/`)).map((p) => p.slice(root.length + 1))
  return { isRepo: true, defaultBranch, base, branches, merged, worktrees }
}

/** Squash-merged: the branch's whole diff since the merge base already is a commit on `base` (patch-id via git cherry). */
async function squashMerged(repo: string, base: string, branch: string): Promise<boolean> {
  try {
    const mb = await git(repo, 'merge-base', base, branch)
    const squash = await git(repo, 'commit-tree', `${branch}^{tree}`, '-p', mb, '-m', 'squash')
    return (await git(repo, 'cherry', base, squash)).startsWith('-')
  } catch {
    return false
  }
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

/**
 * Checks out branch `key` in the main tree (created from HEAD if missing). Returns false for non-git folders.
 * `requireClean` refuses to switch with uncommitted changes, so they aren't carried onto the spec branch.
 */
export async function ensureBranch(repo: string, key: string, requireClean = false): Promise<boolean> {
  if ((await tryGit(repo, 'rev-parse', '--is-inside-work-tree')) !== 'true') return false
  const current = await git(repo, 'branch', '--show-current')
  if (current === key) return true
  if (requireClean && (await git(repo, 'status', '--porcelain')))
    throw new Error(`${current || 'HEAD'} has uncommitted changes – commit or stash them before switching to ${key}, or use "Implement in worktree".`)
  const exists = (await tryGit(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${key}`)) !== undefined
  await (exists ? git(repo, 'switch', key) : git(repo, 'switch', '-c', key))
  return true
}

/**
 * Commits everything in `cwd` as one commit on spec branch `key`, naming the tasks ticked since HEAD (constitution:
 * commits reference task IDs). Never commits on another branch. Returns the short hash, undefined if nothing changed.
 */
export async function commitSpec(cwd: string, key: string): Promise<string | undefined> {
  const current = await git(cwd, 'branch', '--show-current')
  if (current !== key) throw new Error(`the working tree is on ${current || 'a detached HEAD'}, not ${key}`)
  if (!(await git(cwd, 'status', '--porcelain'))) return undefined
  const diff = await git(cwd, 'diff', '-U0', 'HEAD', '--', `specs/${key}/tasks.md`)
  const ticked = [...diff.matchAll(/^\+\s*[-*]\s+\[[xX]\]\s+(T\d+)/gm)].map((m) => m[1])
  await git(cwd, 'add', '-A')
  await git(cwd, 'commit', '-q', '-m', `${key}: implement${ticked.length ? ` ${ticked.join(', ')}` : ''}`)
  return git(cwd, 'rev-parse', '--short', 'HEAD')
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

/** Opens a PR from the spec branch into `base` with GitHub's CLI; returns the PR URL. */
export async function createPr(repo: string, key: string, base: string): Promise<string> {
  await git(repo, 'push', '-u', 'origin', key)
  return run('gh', ['pr', 'create', '--head', key, '--base', base, '--fill'], repo)
}

/**
 * Merges spec branch `key` into `base` in the main tree (--no-ff, never pushed), then removes its worktree and deletes
 * the branch. Needs clean trees; a failed merge is aborted and the previous branch checked out again.
 */
export async function mergeSpec(repo: string, key: string, base: string): Promise<void> {
  const wt = resolve(repo, WORKTREES, key)
  if (existsSync(wt) && (await git(wt, 'status', '--porcelain'))) throw new Error(`The worktree of ${key} has uncommitted changes – commit them first.`)
  if (await git(repo, 'status', '--porcelain')) throw new Error('The main working tree has uncommitted changes – commit or stash them first.')
  const current = await git(repo, 'branch', '--show-current')
  if (current !== base) await git(repo, 'switch', base)
  try {
    await git(repo, 'merge', '--no-ff', '-m', `Merge ${key} into ${base}`, key)
  } catch (e) {
    await tryGit(repo, 'merge', '--abort')
    if (current && current !== base) await tryGit(repo, 'switch', current)
    throw new Error(`Merging ${key} into ${base} failed (conflicts?) – nothing was changed. ${(e as Error).message}`)
  }
  if (existsSync(wt)) await git(repo, 'worktree', 'remove', wt)
  await git(repo, 'branch', '-d', key)
}
