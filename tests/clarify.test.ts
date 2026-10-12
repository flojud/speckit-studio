import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countCritical, parseQuickReplies } from '../src/shared/clarify.ts'

const q = `## Question 1: Auth

**Recommended:** Option B - OAuth fits the existing SSO.

| Option | Description |
|--------|-------------|
| A | Email/password |
| B | OAuth via Google |
| C | Magic links |

You can reply with the option letter (e.g., "A"), accept the recommendation by saying "yes" or "recommended", or provide your own short answer.`

test('parses options and recommendation from a clarify question', () => {
  assert.deepEqual(parseQuickReplies(q), {
    recommended: 'B',
    options: [
      { letter: 'A', label: 'Email/password' },
      { letter: 'B', label: 'OAuth via Google' },
      { letter: 'C', label: 'Magic links' }
    ]
  })
})

test('no options table → no quick replies', () => {
  assert.equal(parseQuickReplies('Format: short answer (<=5 words)'), undefined)
})

test('counts CRITICAL findings in an analysis table', () => {
  const report = `| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| A1 | Duplication | HIGH | spec.md:L1 | x | y |
| C1 | Constitution | CRITICAL | plan.md | x | y |
| C2 | Coverage |  CRITICAL  | tasks.md | x | y |
Critical Issues Count: 2`
  assert.equal(countCritical(report), 2)
  assert.equal(countCritical('No issues found.'), 0)
})
