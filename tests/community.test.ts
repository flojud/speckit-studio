import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

test('package.json: open-source metadata and MIT license', () => {
  const pkgPath = join(ROOT, 'package.json')
  assert.ok(existsSync(pkgPath), 'package.json must exist')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

  assert.equal(pkg.license, 'MIT', 'license must be MIT')
  assert.equal(pkg.author, 'Florian Jud', 'author must be Florian Jud')
  assert.equal(pkg.private, undefined, 'private field should be omitted or false')
  assert.ok(pkg.repository && pkg.repository.url, 'repository url must be specified')
  assert.match(pkg.repository.url, /speckit-studio\.git/, 'repository url must point to speckit-studio')
  assert.ok(pkg.bugs && pkg.bugs.url, 'bugs url must be specified')
  assert.ok(pkg.homepage, 'homepage url must be specified')
  assert.ok(Array.isArray(pkg.keywords), 'keywords must be an array')
  assert.ok(pkg.keywords.includes('spec-kit'), 'keywords must include spec-kit')
  assert.ok(pkg.keywords.includes('acp'), 'keywords must include acp')
  assert.ok(pkg.keywords.includes('spec-driven-development'), 'keywords must include spec-driven-development')
})

test('LICENSE: MIT license and copyright attribution to Florian Jud', () => {
  const licensePath = join(ROOT, 'LICENSE')
  assert.ok(existsSync(licensePath), 'LICENSE file must exist at repository root')
  const content = readFileSync(licensePath, 'utf8')

  assert.match(content, /^MIT License/, 'Must begin with MIT License')
  assert.match(
    content,
    /Copyright \(c\) 2026 Florian Jud/,
    'Must include exact copyright notice for Florian Jud'
  )
  assert.match(content, /Permission is hereby granted, free of charge/, 'Must contain standard MIT permission clause')
})

test('CONTRIBUTING.md: structure and commands', () => {
  const contribPath = join(ROOT, 'CONTRIBUTING.md')
  assert.ok(existsSync(contribPath), 'CONTRIBUTING.md file must exist at repository root')
  const content = readFileSync(contribPath, 'utf8')

  assert.match(content, /npm run dev/, 'Must mention npm run dev')
  assert.match(content, /npm test/, 'Must mention npm test')
  assert.match(content, /npm run typecheck/, 'Must mention npm run typecheck')
  assert.match(content, /Fake agent \(dev\)/, 'Must document Fake agent (dev)')
  assert.doesNotMatch(content, /specs\/|\.specify\//, 'Must not point to Spec Kit files, they are not in the repo')
})

test('CODE_OF_CONDUCT.md: Contributor Covenant v2.1 compliance', () => {
  const cocPath = join(ROOT, 'CODE_OF_CONDUCT.md')
  assert.ok(existsSync(cocPath), 'CODE_OF_CONDUCT.md file must exist at repository root')
  const content = readFileSync(cocPath, 'utf8')

  assert.match(content, /Contributor Covenant/, 'Must identify as Contributor Covenant')
  assert.match(content, /2\.1/, 'Must reference version 2.1')
  assert.match(content, /Our Pledge/, 'Must contain Our Pledge')
  assert.match(content, /Enforcement Guidelines/, 'Must contain Enforcement Guidelines')
})

test('GitHub templates: bug report, feature request, config, and PR template', () => {
  const bugPath = join(ROOT, '.github', 'ISSUE_TEMPLATE', 'bug_report.yml')
  assert.ok(existsSync(bugPath), 'bug_report.yml must exist')
  const bugContent = readFileSync(bugPath, 'utf8')
  assert.match(bugContent, /title:\s*"\[Bug\]:\s*"/, 'Bug report must have [Bug]: title prefix')
  assert.match(bugContent, /id:\s*description/, 'Bug report must include description field')
  assert.match(bugContent, /id:\s*version/, 'Bug report must include version field')
  assert.match(bugContent, /id:\s*os/, 'Bug report must include os dropdown')
  assert.match(bugContent, /id:\s*agent/, 'Bug report must include agent dropdown')
  assert.match(bugContent, /id:\s*steps/, 'Bug report must include steps field')
  assert.match(bugContent, /id:\s*expected/, 'Bug report must include expected field')

  const featPath = join(ROOT, '.github', 'ISSUE_TEMPLATE', 'feature_request.yml')
  assert.ok(existsSync(featPath), 'feature_request.yml must exist')
  const featContent = readFileSync(featPath, 'utf8')
  assert.match(featContent, /title:\s*"\[Feature\]:\s*"/, 'Feature request must have [Feature]: title prefix')
  assert.match(featContent, /id:\s*problem/, 'Feature request must include problem field')
  assert.match(featContent, /id:\s*proposal/, 'Feature request must include proposal field')

  const cfgPath = join(ROOT, '.github', 'ISSUE_TEMPLATE', 'config.yml')
  assert.ok(existsSync(cfgPath), 'config.yml must exist')
  const cfgContent = readFileSync(cfgPath, 'utf8')
  assert.match(cfgContent, /blank_issues_enabled:\s*false/, 'blank_issues_enabled must be false')

  const prPath = join(ROOT, '.github', 'pull_request_template.md')
  assert.ok(existsSync(prPath), 'pull_request_template.md must exist')
  const prContent = readFileSync(prPath, 'utf8')
  assert.match(prContent, /npm run typecheck/, 'PR template must check typecheck')
  assert.match(prContent, /npm test/, 'PR template must check npm test')
  assert.match(prContent, /principles in CONTRIBUTING\.md/, 'PR template must check the project principles')
})

test('GitHub Actions CI: workflow definition on ubuntu-latest', () => {
  const ciPath = join(ROOT, '.github', 'workflows', 'ci.yml')
  assert.ok(existsSync(ciPath), 'ci.yml must exist')
  const content = readFileSync(ciPath, 'utf8')

  assert.match(content, /runs-on:\s*ubuntu-latest/, 'Must run on ubuntu-latest')
  assert.match(content, /node-version:\s*22/, 'Must configure Node.js 22')
  assert.match(content, /npm ci/, 'Must run npm ci')
  assert.match(content, /npm run typecheck/, 'Must run typecheck step')
  assert.match(content, /npm test/, 'Must run test step')
  assert.match(content, /npm run build/, 'Must run build step')
  assert.match(content, /branches:\s*\[\s*devel,\s*main\s*\]/, 'Must trigger on devel and main')
  assert.match(content, /name:\s*CI\b.*\n\s*runs-on/, 'Job must be named CI, the required status check on main')
})

test('SECURITY.md: supported versions and private vulnerability reporting', () => {
  const secPath = join(ROOT, 'SECURITY.md')
  assert.ok(existsSync(secPath), 'SECURITY.md file must exist at repository root')
  const content = readFileSync(secPath, 'utf8')

  assert.match(content, /Supported Versions/, 'Must define supported versions table')
  assert.match(content, /0\.1\.x/, 'Must support 0.1.x release')
  assert.match(content, /Reporting a Vulnerability/, 'Must include vulnerability reporting instructions')
  assert.match(content, /Security Advisor/, 'Must reference GitHub Security Advisories')
})

// electron-builder packs `dependencies` but not their peer dependencies; a missing one crashes the packaged app at startup.
test('package.json: peer dependencies of runtime dependencies are dependencies too', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  for (const dep of Object.keys(pkg.dependencies)) {
    const depPkg = JSON.parse(readFileSync(join(ROOT, 'node_modules', dep, 'package.json'), 'utf8'))
    for (const peer of Object.keys(depPkg.peerDependencies ?? {})) {
      if (peer === 'electron' || depPkg.peerDependenciesMeta?.[peer]?.optional) continue // electron is the runtime itself
      assert.ok(pkg.dependencies[peer], `${dep} needs ${peer} in dependencies`)
    }
  }
})
