import { useEffect, useMemo, useState } from 'react'
import type { Finding, McpServerConfig, McpTransportType } from '../../../shared/types'

/** Space-separated, "double" or 'single' quotes keep spaces. */
const splitArgs = (s: string): string[] => [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3])
const joinArgs = (a: string[] = []): string => a.map((x) => (/\s|^$/.test(x) ? JSON.stringify(x) : x)).join(' ')

/** `KEY=value` (env) or `Name: value` (headers) per line. */
const parsePairs = (text: string, sep: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split('\n')
      .filter((l) => l.includes(sep))
      .map((l) => [l.slice(0, l.indexOf(sep)).trim(), l.slice(l.indexOf(sep) + sep.length).trim()])
      .filter(([k]) => k)
  )
const showPairs = (r: Record<string, string> = {}, sep: string): string =>
  Object.entries(r)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n')

const transportOf = (s: McpServerConfig): McpTransportType => (s.type === 'sse' || s.type === 'http' ? s.type : !s.type && s.url && !s.command ? 'http' : 'stdio')

const formOf = (s: McpServerConfig | null) => ({
  name: s?.name ?? '',
  type: s ? transportOf(s) : ('stdio' as McpTransportType),
  command: s?.command ?? '',
  args: joinArgs(s?.args),
  env: showPairs(s?.env, '='),
  url: s?.url ?? '',
  headers: showPairs(s?.headers, ': ')
})

const input = 'w-full rounded bg-raised border border-line px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent font-mono'

function Badge({ findings }: { findings: Finding[] }): React.JSX.Element | null {
  if (!findings.length) return null
  const err = findings.some((f) => f.severity === 'error')
  return (
    <span
      className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${err ? 'bg-[#eb5757]/15 text-[#eb5757]' : 'bg-[#f2994a]/15 text-[#f2994a]'}`}
      title={findings.map((f) => f.reason).join('\n')}
    >
      {findings.length}
    </span>
  )
}

/** Sidebar row: name, transport, on/off switch, health badge. */
export function McpServerRow(props: { server: McpServerConfig; selected: boolean; findings: Finding[]; onClick: () => void; onToggle: (enabled: boolean) => void }): React.JSX.Element {
  const { server: s, selected, findings, onClick, onToggle } = props
  const t = transportOf(s)
  return (
    <div
      onClick={onClick}
      className={`rounded-md px-2.5 py-2 cursor-pointer flex items-center gap-2 ${selected ? 'bg-raised text-fg' : 'hover:bg-raised/60 text-dim hover:text-fg'} ${s.disabled ? 'opacity-60' : ''}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-fg text-[12px] truncate">{s.name}</span>
          <span className="text-[10px] px-1 rounded bg-dim/15 text-dim font-medium uppercase shrink-0">{t}</span>
        </div>
        <p className="text-[11px] text-dim truncate font-mono">{t === 'stdio' ? [s.command, joinArgs(s.args)].filter(Boolean).join(' ') : s.url}</p>
      </div>
      <Badge findings={findings} />
      <button
        type="button"
        role="switch"
        aria-checked={!s.disabled}
        aria-label={`${s.disabled ? 'Enable' : 'Disable'} ${s.name}`}
        title={s.disabled ? 'Disabled for runs – click to enable' : 'Enabled for runs – click to disable'}
        onClick={(e) => {
          e.stopPropagation()
          onToggle(!!s.disabled)
        }}
        className={`shrink-0 w-7 h-4 rounded-full relative transition-colors ${s.disabled ? 'bg-line' : 'bg-accent'}`}
      >
        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${s.disabled ? 'left-0.5' : 'left-3.5'}`} />
      </button>
    </div>
  )
}

/** Form for one server; `server` null = new. Saving passes the old name so renames happen in place. */
export function McpServerEditor(props: {
  server: McpServerConfig | null
  findings: Finding[]
  onSave: (server: McpServerConfig, oldName?: string) => Promise<void>
  onDelete?: () => void
  onDirty: (dirty: boolean) => void
}): React.JSX.Element {
  const { server, findings, onSave, onDelete, onDirty } = props
  const initial = useMemo(() => formOf(server), [server])
  const [form, setForm] = useState(initial)
  const [error, setError] = useState<string>()
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  useEffect(() => onDirty(dirty), [dirty, onDirty])

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const save = async (): Promise<void> => {
    setError(undefined)
    const stdio = form.type === 'stdio'
    const next: McpServerConfig = {
      name: form.name.trim(),
      ...(stdio ? {} : { type: form.type }),
      ...(stdio ? { command: form.command.trim(), args: splitArgs(form.args), env: parsePairs(form.env, '=') } : { url: form.url.trim(), headers: parsePairs(form.headers, ':') }),
      ...(server?.disabled ? { disabled: true } : {})
    }
    try {
      await onSave(next, server?.name)
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      className="max-w-2xl space-y-3"
    >
      <div className="flex items-center gap-2">
        <h2 className="font-semibold text-fg text-sm flex-1">{server ? `MCP server ${server.name}` : 'New MCP server'}</h2>
        {server?.disabled && <span className="text-[11px] px-1.5 py-0.5 rounded bg-line text-dim">disabled for runs</span>}
      </div>
      {findings.map((f, i) => (
        <div key={i} className={`rounded border p-2 text-[12px] ${f.severity === 'error' ? 'border-[#eb5757]/40 bg-[#eb5757]/10' : 'border-[#f2994a]/40 bg-[#f2994a]/10'}`}>
          <div className="text-fg">{f.reason}</div>
          <div className="text-dim text-[11px]">
            <span className="font-medium text-fg">Fix:</span> {f.fix}
          </div>
        </div>
      ))}
      {error && <div className="text-[#eb5757] text-[12px] bg-[#eb5757]/10 p-2 rounded">{error}</div>}
      <div className="grid grid-cols-[1fr_8rem] gap-2">
        <label className="block">
          <span className="block text-[11px] font-medium text-dim mb-1">Name</span>
          <input autoFocus={!server} required value={form.name} onChange={set('name')} placeholder="e.g. sqlite-local" className={input} />
        </label>
        <label className="block">
          <span className="block text-[11px] font-medium text-dim mb-1">Transport</span>
          <select value={form.type} onChange={set('type')} className={input}>
            <option value="stdio">stdio</option>
            <option value="http">http</option>
            <option value="sse">sse</option>
          </select>
        </label>
      </div>
      {form.type === 'stdio' ? (
        <>
          <label className="block">
            <span className="block text-[11px] font-medium text-dim mb-1">Command</span>
            <input required value={form.command} onChange={set('command')} placeholder="npx, uvx, node or a full path" className={input} />
          </label>
          <label className="block">
            <span className="block text-[11px] font-medium text-dim mb-1">Arguments (space-separated, quote values with spaces)</span>
            <input value={form.args} onChange={set('args')} placeholder="mcp-server-sqlite --db-path ./dev.db" className={input} />
          </label>
          <label className="block">
            <span className="block text-[11px] font-medium text-dim mb-1">Environment (KEY=value per line)</span>
            <textarea rows={3} value={form.env} onChange={set('env')} placeholder="DEBUG=true" className={`${input} resize-y`} />
          </label>
        </>
      ) : (
        <>
          <label className="block">
            <span className="block text-[11px] font-medium text-dim mb-1">URL</span>
            <input required value={form.url} onChange={set('url')} placeholder="https://example.com/mcp" className={input} />
          </label>
          <label className="block">
            <span className="block text-[11px] font-medium text-dim mb-1">Headers (Name: value per line)</span>
            <textarea rows={3} value={form.headers} onChange={set('headers')} placeholder="Authorization: Bearer …" className={`${input} resize-y`} />
          </label>
        </>
      )}
      <div className="flex items-center gap-2 pt-1">
        <button type="submit" disabled={!!server && !dirty} className="rounded-md bg-accent text-white px-3 py-1.5 text-[12px] font-medium disabled:opacity-40">
          {server ? 'Save' : 'Add server'}
        </button>
        {dirty && server && (
          <button type="button" onClick={() => setForm(initial)} className="rounded-md px-2.5 py-1.5 text-[12px] text-dim hover:text-fg">
            Revert
          </button>
        )}
        {onDelete && (
          <button type="button" onClick={onDelete} className="ml-auto px-2.5 py-1 rounded border border-line text-[#eb5757] hover:bg-[#eb5757]/10 text-[12px]">
            Delete
          </button>
        )}
      </div>
    </form>
  )
}
