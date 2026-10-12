import { useEffect, useRef, useState } from 'react'

export interface PaletteItem {
  id: string
  label: string
  hint?: string
  run: () => void
}

/** ⌘K command palette: every word of the query must appear in the label. */
export function Palette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = items.filter((i) => words.every((w) => i.label.toLowerCase().includes(w))).slice(0, 50)
  const pick = (i: PaletteItem | undefined): void => {
    if (!i) return
    onClose()
    i.run()
  }
  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    list.current?.children[index]?.scrollIntoView({ block: 'nearest' })
  }, [index])

  return (
    <div className="fixed inset-0 z-20 bg-black/50 flex justify-center pt-[15vh]" onClick={onClose}>
      <div className="w-[600px] h-fit rounded-xl border border-line bg-panel shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setIndex((i) => Math.min(i + 1, matches.length - 1))
            else if (e.key === 'ArrowUp') setIndex((i) => Math.max(i - 1, 0))
            else if (e.key === 'Enter') pick(matches[index])
            else if (e.key === 'Escape') onClose()
            else return
            e.preventDefault()
          }}
          placeholder="Type a command or search specs…"
          className="w-full bg-transparent px-4 py-3 text-[14px] outline-none border-b border-line select-text"
        />
        <ul ref={list} className="max-h-[50vh] overflow-y-auto py-1">
          {matches.map((m, i) => (
            <li key={m.id}>
              <button
                onMouseMove={() => setIndex(i)}
                onClick={() => pick(m)}
                className={`w-full flex items-center px-4 py-2 text-left ${i === index ? 'bg-raised text-fg' : 'text-dim'}`}
              >
                <span className="truncate">{m.label}</span>
                {m.hint && <span className="ml-auto pl-3 text-[11px] text-dim">{m.hint}</span>}
              </button>
            </li>
          ))}
          {matches.length === 0 && <li className="px-4 py-2 text-dim">No matches</li>}
        </ul>
      </div>
    </div>
  )
}
