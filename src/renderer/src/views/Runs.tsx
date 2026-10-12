import type { Run } from '../../../shared/types'
import { RunList, useRuns } from './SpecDetail'

/** All runs of the project, including project-level ones (specify, constitution). */
export function Runs({ projectId, rev, onOpen }: { projectId: number; rev: number; onOpen: (r: Run) => void }): React.JSX.Element {
  const runs = useRuns(projectId, undefined, rev)
  return <div className="px-6 py-5">{runs.length ? <RunList runs={runs} onOpen={onOpen} /> : <p className="text-dim">No runs yet.</p>}</div>
}
