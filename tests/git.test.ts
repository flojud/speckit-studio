import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addWorktree, applyGit, commitSpec, ensureBranch, mergeSpec, gitInfo, removeWorktree, specRefNames } from '../src/main/git.ts'
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

test('implement: ensureBranch refuses a dirty switch, commitSpec commits only on the spec branch with ticked task IDs', async () => {
  const dir = repo()
  sh(dir, 'config', 'user.email', 't@t')
  sh(dir, 'config', 'user.name', 't')
  mkdirSync(join(dir, 'specs/030-x'), { recursive: true })
  writeFileSync(join(dir, 'specs/030-x/tasks.md'), '- [ ] T001 a\n- [ ] T002 b\n')
  await assert.rejects(ensureBranch(dir, '030-x', true), /main has uncommitted changes/)
  await assert.rejects(commitSpec(dir, '030-x'), /on main, not 030-x/)
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-qm', 'tasks')
  assert.equal(await ensureBranch(dir, '030-x', true), true)
  assert.equal(await commitSpec(dir, '030-x'), undefined)
  writeFileSync(join(dir, 'specs/030-x/tasks.md'), '- [x] T001 a\n- [X] T002 b\n')
  writeFileSync(join(dir, 'code.ts'), 'x')
  const hash = await commitSpec(dir, '030-x')
  assert.equal(sh(dir, 'rev-parse', '--short', 'HEAD').trim(), hash)
  assert.equal(sh(dir, 'log', '-1', '--format=%s').trim(), '030-x: implement T001, T002')
  assert.equal(sh(dir, 'status', '--porcelain'), '')
  assert.equal(await ensureBranch(dir, '030-x', true), true) // already there: no switch, no check
})

test('mergeSpec merges --no-ff into the base locally, deletes branch and worktree; squash merges count as merged', async () => {
  const dir = repo()
  sh(dir, 'config', 'user.email', 't@t')
  sh(dir, 'config', 'user.name', 't')
  sh(dir, 'branch', 'devel')
  const wt = await addWorktree(dir, '040-a')
  writeFileSync(join(wt, 'a.ts'), 'a')
  await assert.rejects(mergeSpec(dir, '040-a', 'devel'), /worktree of 040-a has uncommitted/)
  sh(wt, 'add', '-A')
  sh(wt, 'commit', '-qm', 'a')
  assert.equal((await gitInfo(dir)).base, 'devel')
  await mergeSpec(dir, '040-a', 'devel')
  assert.equal(sh(dir, 'branch', '--show-current').trim(), 'devel')
  assert.match(sh(dir, 'log', '-1', '--format=%s'), /^Merge 040-a into devel/)
  assert.ok(existsSync(join(dir, 'a.ts')))
  const info = await gitInfo(dir)
  assert.deepEqual([info.branches.includes('040-a'), info.worktrees], [false, []])

  // Squash merge (as GitHub does it): branch tip is no ancestor of devel, but its diff is.
  sh(dir, 'switch', '-qc', '041-b')
  writeFileSync(join(dir, 'b.ts'), 'b')
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-qm', 'b')
  sh(dir, 'switch', '-q', 'devel')
  assert.ok(!(await gitInfo(dir)).merged.includes('041-b'))
  sh(dir, 'merge', '-q', '--squash', '041-b')
  sh(dir, 'commit', '-qm', 'b (#1)')
  assert.ok((await gitInfo(dir)).merged.includes('041-b'))

  // A conflict is aborted and the previous branch restored.
  sh(dir, 'switch', '-qc', '042-c')
  writeFileSync(join(dir, 'b.ts'), 'c')
  sh(dir, 'commit', '-qam', 'c')
  sh(dir, 'switch', '-q', 'devel')
  writeFileSync(join(dir, 'b.ts'), 'd')
  sh(dir, 'commit', '-qam', 'd')
  sh(dir, 'switch', '-q', '042-c')
  await assert.rejects(mergeSpec(dir, '042-c', 'devel'), /nothing was changed/)
  assert.equal(sh(dir, 'branch', '--show-current').trim(), '042-c')
  assert.equal(sh(dir, 'status', '--porcelain'), '')
})
