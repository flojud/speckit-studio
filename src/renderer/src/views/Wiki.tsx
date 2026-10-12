import { useEffect, useState } from 'react'
import type { ProjectSnapshot } from '../../../shared/types'
import { resolvePage } from '../../../shared/wiki'
import { Markdown } from '../components/Markdown'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { useFile } from '../useFile'

interface Props {
  projectId: number
  snap: ProjectSnapshot
  rev: number
  page?: string
  onPage: (file: string) => void
  onOpenSpec: (key: string) => void
}

const DIR = 'docs/wiki'

export function Wiki({ projectId, snap, rev, page, onPage, onOpenSpec }: Props): React.JSX.Element {
  const pages = snap.wiki
  const current = pages.find((p) => p.file === page) ?? pages[0]
  const text = useFile(projectId, current && `${DIR}/${current.file}`, rev)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [links, setLinks] = useState<string[]>([])

  useEffect(() => setEditing(false), [current?.file])
  useEffect(() => {
    if (current) window.api.wiki.backlinks(projectId, current.file).then(setLinks)
  }, [projectId, current, rev])

  async function create(name: string): Promise<void> {
    setError(undefined)
    try {
      onPage(await window.api.wiki.create(projectId, name))
      setTitle('')
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const follow = (name: string): void => {
    const target = resolvePage(pages, name)
    if (target) onPage(target.file)
    else void create(name)
  }

  return (
    <div className="flex h-full">
      <nav className="w-60 shrink-0 border-r border-line p-3 space-y-3 overflow-y-auto">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (title.trim()) void create(title.trim())
          }}
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New page title…"
            className="w-full bg-raised border border-line rounded px-2 py-1 outline-none focus:border-accent select-text"
          />
        </form>
        {error && <p className="text-[#eb5757] text-[12px]">{error}</p>}
        <ul className="space-y-0.5">
          {pages.map((p) => (
            <li key={p.file}>
              <button
                onClick={() => onPage(p.file)}
                className={`w-full truncate rounded-md px-2 py-1 text-left ${p.file === current?.file ? 'bg-raised text-fg' : 'text-dim hover:bg-raised hover:text-fg'}`}
                title={p.file}
              >
                {p.title}
              </button>
            </li>
          ))}
        </ul>
        {pages.length === 0 && <p className="text-dim text-[12px]">No pages yet. Pages are Markdown files in {DIR}/.</p>}
        <button
          onClick={() => window.api.wiki.linkAgents(projectId).then((f) => setNotice(f.length ? `Added wiki section to ${f.join(', ')}` : 'Agents already know the wiki'))}
          className="w-full rounded-md border border-line px-2 py-1 text-dim hover:text-fg text-[12px]"
          title="Adds a short 'Project wiki' section to CLAUDE.md / AGENTS.md"
        >
          Link wiki for agents
        </button>
        {notice && <p className="text-dim text-[12px]">{notice}</p>}
      </nav>

      <div className="flex-1 min-w-0 overflow-auto px-6 py-5">
        {!current ? null : editing && text != null ? (
          <MarkdownEditor initial={text} onCancel={() => setEditing(false)} onSave={(t) => window.api.writeFile(projectId, `${DIR}/${current.file}`, t).then(() => setEditing(false))} />
        ) : (
          <div className="space-y-6">
            <div className="flex items-center gap-2 text-dim text-[12px]">
              <span>{DIR}/{current.file}</span>
              <button onClick={() => setEditing(true)} className="ml-auto rounded-md border border-line px-2.5 py-1 hover:text-fg">
                Edit
              </button>
            </div>
            {text && <Markdown text={text} onWikiLink={follow} exists={(n) => !!resolvePage(pages, n)} />}
            {links.length > 0 && (
              <section className="max-w-3xl border-t border-line pt-3">
                <h3 className="text-dim font-medium mb-1.5">Linked from</h3>
                <ul className="space-y-0.5">
                  {links.map((f) => {
                    const wiki = f.startsWith(`${DIR}/`) ? f.slice(DIR.length + 1) : undefined
                    const spec = f.match(/^specs\/([^/]+)\//)?.[1]
                    return (
                      <li key={f}>
                        <button onClick={() => (wiki ? onPage(wiki) : spec && onOpenSpec(spec))} className="text-accent hover:underline">
                          {wiki ? (pages.find((p) => p.file === wiki)?.title ?? wiki) : f}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
