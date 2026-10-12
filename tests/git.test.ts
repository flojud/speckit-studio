import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addWorktree, applyGit, ensureBranch, gitInfo, removeWorktree, specRefNames } from '../src/main/git.ts'
import type { Spec } from '../src/shared/types.ts'

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-'))
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  return dir
}
const spec = (key: string, phase: Spec['phase']): Spec => ({ key, number: '', title: key, phase, artifacts: [], tasks: [], openClarifications: 0, dir: `specs/${key}` })

test('gitInfo + applyGit: merged, unmerged and missing branches', async () => {
  const dir = repo()
  sh(dir, 'branch', '001-merged')
  sh(dir, 'checkout', '-q', '-b', '002-open')
  sh(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'work')
  sh(dir, 'checkout', '-q', 'main')
  const info = await gitInfo(dir)
  assert.equal(info.defaultBranch, 'main')
  const specs = [spec('001-merged', 'done'), spec('002-open', 'done'), spec('003-none', 'done')]
  applyGit(specs, info)
  assert.deepEqual(specs.map((s) => [s.git?.state, s.phase]), [['merged', 'done'], ['branch', 'implementing'], ['none', 'done']])
})

test('worktrees are created under .studio, excluded from git, listed and removed', async () => {
  const dir = repo()
  const path = await addWorktree(dir, '004-wt')
  assert.ok(existsSync(join(path, '.git')))
  assert.match(readFileSync(join(dir, '.git/info/exclude'), 'utf8'), /^\.studio\/$/m)
  assert.equal(sh(dir, 'status', '--porcelain'), '')
  assert.deepEqual((await gitInfo(dir)).worktrees, ['004-wt'])
  writeFileSync(join(path, 'x.txt'), 'x')
  await assert.rejects(removeWorktree(dir, '004-wt'), /uncommitted changes/)
  sh(path, 'clean', '-fq')
  await removeWorktree(dir, '004-wt')
  assert.deepEqual((await gitInfo(dir)).worktrees, [])
})

test('non-repo folders report isRepo false', async () => {
  assert.equal((await gitInfo(mkdtempSync(join(tmpdir(), 'nogit-')))).isRepo, false)
})

test('specRefNames lists local, remote-tracking and worktree spec names', async () => {
  const dir = repo()
  sh(dir, 'branch', '014-local')
  sh(dir, 'update-ref', 'refs/remotes/origin/015-remote', 'HEAD')
  mkdirSync(join(dir, '.studio/worktrees/x/specs/016-wt'), { recursive: true })
  const names = await specRefNames(dir)
  for (const n of ['014-local', '015-remote', '016-wt', 'main']) assert.ok(names.includes(n), n)
  assert.ok(!names.some((n) => n.startsWith('origin/')))
  assert.deepEqual(await specRefNames(mkdtempSync(join(tmpdir(), 'nogit-'))), [])
})

test('ensureBranch creates or switches to the spec branch and keeps untracked drafts', async () => {
  const dir = repo()
  mkdirSync(join(dir, 'specs/020-x'), { recursive: true })
  writeFileSync(join(dir, 'specs/020-x/draft.md'), '# X\n')
  assert.equal(await ensureBranch(dir, '020-x'), true)
  assert.equal(sh(dir, 'branch', '--show-current').trim(), '020-x')
  assert.ok(existsSync(join(dir, 'specs/020-x/draft.md')))
  sh(dir, 'switch', '-q', 'main')
  await ensureBranch(dir, '020-x')
  assert.equal(sh(dir, 'branch', '--show-current').trim(), '020-x')
  assert.equal(await ensureBranch(mkdtempSync(join(tmpdir(), 'nogit-')), '020-x'), false)
})
