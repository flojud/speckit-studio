import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareSemver, isNewerVersion } from '../src/shared/semver.ts'
import { getUnreadSteps, ONBOARDING_STEPS, shouldAutoOpenOnboarding } from '../src/shared/onboarding.ts'
import type { OnboardingPreferences, OnboardingStep } from '../src/shared/types.ts'

test('compareSemver orders by major, minor, patch numerically', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0)
  assert.equal(compareSemver('0.10.0', '0.9.9'), 1)
  assert.equal(compareSemver('0.1.0', '1.0.0'), -1)
  assert.equal(compareSemver('v1.2.3', '1.2.3'), 0)
  assert.equal(compareSemver('1.2.3-beta.1', '1.2.3'), 0)
  assert.equal(isNewerVersion('0.1.1', '0.1.0'), true)
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false)
})

test('catalog has 9 steps with unique ids, valid semver and 2–5 highlights', () => {
  assert.equal(ONBOARDING_STEPS.length, 9)
  assert.equal(new Set(ONBOARDING_STEPS.map((s) => s.id)).size, 9)
  for (const s of ONBOARDING_STEPS) {
    assert.match(s.version, /^\d+\.\d+\.\d+$/)
    assert.ok(s.highlights.length >= 2 && s.highlights.length <= 5, s.id)
    assert.ok(s.title && s.title.length <= 50 && s.summary && s.category, s.id)
  }
})

test('getUnreadSteps returns steps newer than lastSeenVersion in catalog order', () => {
  const step = (id: string, version: string): OnboardingStep => ({ id, version, title: id, category: '', summary: '', highlights: [], icon: 'compass' })
  const catalog = [step('a', '0.1.0'), step('b', '1.1.0'), step('c', '1.0.0'), step('d', '1.2.0')]
  assert.deepEqual(getUnreadSteps(catalog, '1.0.0').map((s) => s.id), ['b', 'd'])
  assert.deepEqual(getUnreadSteps(catalog, '1.2.0'), [])
  assert.deepEqual(getUnreadSteps(catalog, undefined).map((s) => s.id), ['a', 'b', 'c', 'd'])
  assert.equal(getUnreadSteps(ONBOARDING_STEPS, '0.0.9').length, 9)
  assert.deepEqual(getUnreadSteps(ONBOARDING_STEPS, '0.1.3').map((s) => s.id), ['project-agent', 'spec-branches'])
  assert.equal(getUnreadSteps(ONBOARDING_STEPS, '0.2.0').length, 0)
})

test('auto-open only on a true first run (no record, no projects)', () => {
  const prefs: OnboardingPreferences = { completed: false, dismissed: true, lastSeenVersion: '0.1.0' }
  assert.equal(shouldAutoOpenOnboarding({ prefs: null, projectCount: 0 }), true)
  assert.equal(shouldAutoOpenOnboarding({ prefs: null, projectCount: 2 }), false) // upgrading user: badge only
  assert.equal(shouldAutoOpenOnboarding({ prefs, projectCount: 0 }), false)
  assert.equal(shouldAutoOpenOnboarding({ prefs: { ...prefs, completed: true, dismissed: false }, projectCount: 3 }), false)
})
