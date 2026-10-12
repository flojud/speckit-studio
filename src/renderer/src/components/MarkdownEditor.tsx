import { useEffect, useRef, useState } from 'react'
import { Markdown } from './Markdown'

/** Textarea + live preview. ⌘S saves, Esc cancels. */
export function MarkdownEditor(props: {
  initial: string
  onSave: (text: string) => Promise<void>
  onCancel: () => void
  onDirty?: (dirty: boolean) => void
  external?: string
  preview?: boolean
}): React.JSX.Element {
  const [text, setText] = useState(props.initial)
  const [error, setError] = useState<string>()
  const [diskConflict, setDiskConflict] = useState<string | null>(null)
  const lastExternal = useRef(props.external ?? props.initial)

  const isDirty = text !== props.initial

  useEffect(() => {
    props.onDirty?.(isDirty)
  }, [isDirty, props.onDirty])

  useEffect(() => {
    if (props.external === undefined) return
    if (props.external === lastExternal.current) return
    if (isDirty) {
      setDiskConflict(props.external)
    } else {
      setText(props.external)
      lastExternal.current = props.external
    }
  }, [props.external, isDirty])

  const save = (): void => {
    setError(undefined)
    props.onSave(text).then(() => setDiskConflict(null)).catch((e: Error) => setError(e.message))
  }

  const handleCancel = (): void => {
    if (isDirty && !window.confirm('Discard unsaved changes?')) return
    props.onCancel()
  }

  const showPreview = props.preview !== false

  return (
    <div className="flex flex-col h-full gap-2">
      {diskConflict && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-[#eb5757]/15 border border-[#eb5757]/30 text-[12px]">
          <span className="font-medium text-[#eb5757]">Changed on disk</span>
          <span className="text-dim">The file was modified externally.</span>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => {
                setText(diskConflict)
                lastExternal.current = diskConflict
                setDiskConflict(null)
              }}
              className="px-2 py-0.5 rounded bg-raised border border-line text-fg hover:bg-dim/20"
            >
              Reload
            </button>
            <button
              onClick={() => {
                lastExternal.current = diskConflict
                setDiskConflict(null)
              }}
              className="px-2 py-0.5 rounded bg-raised border border-line text-fg hover:bg-dim/20"
            >
              Overwrite
            </button>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={save} className="rounded-md bg-accent text-white px-2.5 py-1">
          Save ⌘S
        </button>
        <button onClick={handleCancel} className="rounded-md px-2.5 py-1 text-dim hover:text-fg">
          Cancel
        </button>
        {error && <span className="text-[#eb5757] text-[12px]">{error}</span>}
      </div>
      <div className={`flex-1 min-h-0 ${showPreview ? 'grid grid-cols-2 gap-4' : 'flex flex-col'}`}>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              save()
            } else if (e.key === 'Escape') {
              handleCancel()
            }
          }}
          spellCheck={false}
          className="h-full min-h-[60vh] resize-none rounded-md bg-raised border border-line p-3 font-mono text-[12px] leading-relaxed outline-none focus:border-accent select-text"
        />
        {showPreview && (
          <div className="overflow-auto">
            <Markdown text={text} />
          </div>
        )}
      </div>
    </div>
  )
}
