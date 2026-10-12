import { useEffect } from 'react'
import type { Project } from '../../../shared/types'

export interface RemoveProjectDialogProps {
  project: Project
  hasActiveRun?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function RemoveProjectDialog({
  project,
  hasActiveRun,
  onCancel,
  onConfirm
}: RemoveProjectDialogProps): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-black/50" onClick={onCancel}>
      <div
        className="w-[500px] rounded-xl border border-line bg-panel p-5 space-y-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="space-y-1">
          <h2 className="text-[16px] font-semibold text-fg">Remove Project</h2>
          <p className="text-[13px] text-dim">
            Are you sure you want to remove <span className="font-medium text-fg">{project.name}</span> from Speckit Studio?
          </p>
          <p className="text-[11px] text-dim font-mono break-all bg-raised rounded px-2 py-1 select-text">
            {project.path}
          </p>
        </div>

        <p className="text-[13px] text-dim">
          This only removes the project from Speckit Studio. Your repository files, branches, and commits on disk will not be deleted or modified.
        </p>

        {hasActiveRun && (
          <div className="rounded-md border border-[#eb575744] bg-[#eb575718] p-3 text-[13px] text-[#eb5757]">
            Warning: An agent run is currently in progress for this project. Removing the project will abort the run.
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[13px] text-dim hover:text-fg hover:bg-raised transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            onClick={onConfirm}
            className="rounded-md bg-[#eb5757] hover:bg-[#d44545] text-white px-3 py-1.5 text-[13px] font-medium transition-colors"
          >
            {hasActiveRun ? 'Abort Run and Remove' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  )
}
