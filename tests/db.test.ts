import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addProject, addRunEvent, createRun, failStaleRuns, getAgent, listRunEvents, listRuns, openDb, setRunStatus } from '../src/main/db.ts'

test('migrations seed claude and persist runs with ordered events', () => {
  openDb(':memory:')
  assert.deepEqual(getAgent('claude')?.args, ['-y', '@agentclientprotocol/claude-agent-acp'])
  const p = addProject('/tmp/x')
  const run = createRun({ projectId: p.id, specKey: '001-a', agent: 'claude', prompt: '/speckit-plan' })
  assert.equal(run.status, 'running')
  addRunEvent(run.id, { type: 'user', text: 'a' })
  addRunEvent(run.id, { type: 'status', status: 'waiting' })
  assert.deepEqual(listRunEvents(run.id).map((e) => e.type), ['user', 'status'])
  setRunStatus(run.id, 'waiting')
  failStaleRuns()
  const [r] = listRuns(p.id, '001-a')
  assert.equal(r.status, 'failed')
  assert.ok(r.ended)
})

test('PM data: assignments, set-null on delete, dependency guards', async () => {
  const db = await import('../src/main/db.ts')
  db.openDb(':memory:')
  const p = db.addProject('/tmp/pm')
  db.createEpic(p.id, 'Auth')
  db.createMilestone(p.id, 'v1', '2026-12-01')
  const [epic] = db.getPm(p.id).epics
  db.setSpecMeta(p.id, '002-b', 'epic_id', epic.id)
  db.addDependency(p.id, '003-c', '002-b')
  db.addDependency(p.id, '003-c', '002-b')
  assert.throws(() => db.addDependency(p.id, '003-c', '003-c'))
  assert.equal(db.getPm(p.id).deps.length, 1)
  db.deleteEpic(epic.id)
  assert.deepEqual(db.getPm(p.id).meta.map((m) => ({ ...m })), [{ specKey: '002-b', epicId: null, milestoneId: null }])
})

test('settings round-trip and agent delete', async () => {
  const db = await import('../src/main/db.ts')
  db.openDb(':memory:')
  assert.deepEqual(db.getPhaseAgents(), {})
  db.setSetting('phaseAgents', { implement: 'claude' })
  assert.deepEqual(db.getPhaseAgents(), { implement: 'claude' })
  db.deleteAgent('claude')
  assert.equal(db.getAgent('claude'), undefined)
})

test('forgetSpec drops assignments and dependencies of one spec only', async () => {
  const db = await import('../src/main/db.ts')
  db.openDb(':memory:')
  const p = db.addProject('/tmp/forget')
  db.createEpic(p.id, 'E')
  const [epic] = db.getPm(p.id).epics
  db.setSpecMeta(p.id, '010-a', 'epic_id', epic.id)
  db.setSpecMeta(p.id, '011-b', 'epic_id', epic.id)
  db.addDependency(p.id, '010-a', '011-b')
  db.addDependency(p.id, '012-c', '010-a')
  db.addDependency(p.id, '012-c', '011-b')
  db.forgetSpec(p.id, '010-a')
  const pm = db.getPm(p.id)
  assert.deepEqual(pm.meta.map((m) => m.specKey), ['011-b'])
  assert.deepEqual(pm.deps.map((d) => ({ ...d })), [{ specKey: '012-c', blockedBy: '011-b' }])
})

test('work_item_meta: assignments, set-null on PM delete, forget, project cascade', async () => {
  const db = await import('../src/main/db.ts')
  db.openDb(':memory:')
  const p = db.addProject('/tmp/wi')
  db.createEpic(p.id, 'Growth')
  db.createMilestone(p.id, 'Launch', '2026-12-01')
  const { epics: [epic], milestones: [ms] } = db.getPm(p.id)
  db.setWorkItemMeta(p.id, 'WI-001-a', 'epic_id', epic.id)
  db.setWorkItemMeta(p.id, 'WI-001-a', 'milestone_id', ms.id)
  db.setWorkItemMeta(p.id, 'WI-002-b', 'epic_id', epic.id)
  assert.deepEqual(db.getPm(p.id).workItemMeta!.map((m) => ({ ...m })), [
    { workItemKey: 'WI-001-a', epicId: epic.id, milestoneId: ms.id },
    { workItemKey: 'WI-002-b', epicId: epic.id, milestoneId: null }
  ])
  db.deleteMilestone(ms.id)
  assert.equal(db.getPm(p.id).workItemMeta![0].milestoneId, null)
  db.forgetWorkItem(p.id, 'WI-001-a')
  assert.deepEqual(db.getPm(p.id).workItemMeta!.map((m) => m.workItemKey), ['WI-002-b'])
  db.removeProject(p.id)
  assert.equal(db.getPm(p.id).workItemMeta!.length, 0)
})

test('removeProject cascades cleanly across all child tables', async () => {
  const db = await import('../src/main/db.ts')
  db.openDb(':memory:')
  const p = db.addProject('/tmp/cascade-project')
  
  // Child table: runs & run_events
  const run = db.createRun({ projectId: p.id, specKey: '001-a', agent: 'claude', prompt: 'test' })
  db.addRunEvent(run.id, { type: 'user', text: 'hello' })
  db.addRunEvent(run.id, { type: 'status', status: 'done' })
  
  // Child table: analysis_reports
  db.saveAnalysis(run.id, p.id, '001-a', 2, '# Analysis Report')
  
  // Child table: epics
  db.createEpic(p.id, 'Infrastructure', 'Scale up')
  const [epic] = db.getPm(p.id).epics
  
  // Child table: milestones
  db.createMilestone(p.id, 'v1.0', '2026-12-01')
  const [milestone] = db.getPm(p.id).milestones
  
  // Child table: spec_meta
  db.setSpecMeta(p.id, '001-a', 'epic_id', epic.id)
  db.setSpecMeta(p.id, '001-a', 'milestone_id', milestone.id)
  
  // Child table: dependencies
  db.addDependency(p.id, '002-b', '001-a')
  
  // Verify data is populated
  assert.equal(db.listRuns(p.id).length, 1)
  assert.equal(db.listRunEvents(run.id).length, 2)
  assert.ok(db.getAnalysisMarkdown(run.id))
  assert.equal(db.latestAnalyses(p.id).length, 1)
  assert.equal(db.getPm(p.id).epics.length, 1)
  assert.equal(db.getPm(p.id).milestones.length, 1)
  assert.equal(db.getPm(p.id).meta.length, 1)
  assert.equal(db.getPm(p.id).deps.length, 1)

  // Execute project removal
  db.removeProject(p.id)

  // Verify project is removed
  assert.equal(db.getProject(p.id), undefined)
  assert.ok(!db.listProjects().some((x) => x.id === p.id))

  // Verify cascade cleanly removed all child records
  assert.equal(db.listRuns(p.id).length, 0)
  assert.equal(db.listRunEvents(run.id).length, 0)
  assert.equal(db.getAnalysisMarkdown(run.id), null)
  assert.equal(db.latestAnalyses(p.id).length, 0)
  const pmAfter = db.getPm(p.id)
  assert.equal(pmAfter.epics.length, 0)
  assert.equal(pmAfter.milestones.length, 0)
  assert.equal(pmAfter.meta.length, 0)
  assert.equal(pmAfter.deps.length, 0)
})

test('phaseConfigs and globalDefaults CRUD operations and legacy synchronization', async () => {
  const db = await import('../src/main/db.ts')
  db.openDb(':memory:')

  // 1. Initial state
  assert.deepEqual(db.getPhaseConfigs(), {})
  assert.deepEqual(db.getGlobalDefaults(), {})

  // 2. Set and get phaseConfigs
  db.setPhaseConfigs({
    specify: { agentId: 'antigravity-acp', model: 'gemini-2.5-pro', effort: 'high' },
    implement: { agentId: 'claude', model: 'sonnet', effort: 'low' }
  })
  assert.deepEqual(db.getPhaseConfigs(), {
    specify: { agentId: 'antigravity-acp', model: 'gemini-2.5-pro', effort: 'high' },
    implement: { agentId: 'claude', model: 'sonnet', effort: 'low' }
  })

  // 3. Bidirectional sync with legacy getPhaseAgents()
  assert.deepEqual(db.getPhaseAgents(), {
    specify: 'antigravity-acp',
    implement: 'claude'
  })

  // 4. Global defaults CRUD
  db.setGlobalDefaults({ model: 'sonnet', effort: 'medium' })
  assert.deepEqual(db.getGlobalDefaults(), { model: 'sonnet', effort: 'medium' })

  // 5. Calling legacy setPhaseAgents updates phaseConfigs preserving model/effort
  db.setPhaseAgents({
    specify: 'antigravity-acp',
    implement: 'custom-agent',
    plan: 'claude'
  })
  assert.deepEqual(db.getPhaseConfigs(), {
    specify: { agentId: 'antigravity-acp', model: 'gemini-2.5-pro', effort: 'high' },
    implement: { agentId: 'custom-agent', model: 'sonnet', effort: 'low' },
    plan: { agentId: 'claude' }
  })
  assert.deepEqual(db.getPhaseAgents(), {
    specify: 'antigravity-acp',
    implement: 'custom-agent',
    plan: 'claude'
  })

  // 6. Legacy fallback when only phaseAgents exists in db
  db.openDb(':memory:')
  db.setSetting('phaseAgents', { tasks: 'claude', analyze: 'antigravity-acp' })
  assert.deepEqual(db.getPhaseConfigs(), {
    tasks: { agentId: 'claude' },
    analyze: { agentId: 'antigravity-acp' }
  })
  assert.deepEqual(db.getPhaseAgents(), {
    tasks: 'claude',
    analyze: 'antigravity-acp'
  })
})

