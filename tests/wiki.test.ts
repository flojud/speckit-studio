import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderWikiLinks, resolvePage, slugify, wikiLinks } from '../src/shared/wiki.ts'

test('extracts distinct wikilink targets', () => {
  assert.deepEqual(wikiLinks('See [[Auth Decisions]] and [[ Auth Decisions |why]], [[Setup]].'), ['Auth Decisions', 'Setup'])
})

test('renders wikilinks as #wiki anchors', () => {
  assert.equal(renderWikiLinks('[[Auth Decisions]] / [[Setup|how to]]'), '[Auth Decisions](#wiki/Auth%20Decisions) / [how to](#wiki/Setup)')
})

test('slugify handles umlauts and punctuation', () => {
  assert.equal(slugify('Entscheidungen: Äpfel & Öl!'), 'entscheidungen-apfel-ol')
  assert.equal(slugify('!!!'), 'page')
})

test('resolves pages by title or file name', () => {
  const pages = [{ file: 'auth-decisions.md', title: 'Auth Decisions' }, { file: 'ops/setup.md', title: 'Local Setup' }]
  assert.equal(resolvePage(pages, 'auth decisions')?.file, 'auth-decisions.md')
  assert.equal(resolvePage(pages, 'Local Setup')?.file, 'ops/setup.md')
  assert.equal(resolvePage(pages, 'nope'), undefined)
})
