import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { addToolPaths, isNewer, mergePath, parseShellPath, parseVersion } from '../src/main/env.ts'

test('extracts PATH between markers despite shell noise', () => {
  assert.equal(parseShellPath('Welcome!\n__STUDIO_PATH__/opt/homebrew/bin:/usr/bin__STUDIO_PATH__\n'), '/opt/homebrew/bin:/usr/bin')
  assert.equal(parseShellPath('no markers'), undefined)
  assert.equal(parseShellPath('__STUDIO_PATH____STUDIO_PATH__'), undefined)
})

test('merges shell PATH first without duplicates', () => {
  assert.equal(mergePath('/usr/bin:/bin:/custom', '/opt/homebrew/bin:/usr/bin'), '/opt/homebrew/bin:/usr/bin:/bin:/custom')
  assert.equal(mergePath(undefined, '/a'), '/a')
})

test('parses versions from typical --version output', () => {
  assert.equal(parseVersion('git version 2.50.1 (Apple Git-155)'), '2.50.1')
  assert.equal(parseVersion('specify 0.9.5'), '0.9.5')
  assert.equal(parseVersion('2.1.286 (Claude Code)'), '2.1.286')
  assert.equal(parseVersion('gh version 2.80'), '2.80')
  assert.equal(parseVersion('ok'), undefined)
})

test('puts folders of configured tool paths in front of PATH, expanding ~ and ignoring relative paths', () => {
  const saved = process.env.PATH
  process.env.PATH = '/usr/bin:/bin'
  addToolPaths({ gh: ' /opt/homebrew/bin/gh ', uv: '~/.local/bin/uv', npx: '', git: 'git', x: '/usr/bin/x' })
  assert.equal(process.env.PATH, `/opt/homebrew/bin:${homedir()}/.local/bin:/usr/bin:/bin`)
  process.env.PATH = saved
})

test('compares release versions numerically', () => {
  assert.equal(isNewer('v0.1.10', '0.1.9'), true)
  assert.equal(isNewer('v0.1.3', '0.1.3'), false)
  assert.equal(isNewer('0.1.4', '0.2.0'), false)
  assert.equal(isNewer('1.0', '0.9.9'), true)
})
