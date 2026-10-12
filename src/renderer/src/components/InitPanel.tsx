import { useState } from 'react'

const INTEGRATIONS = ['claude', 'agy', 'gemini', 'copilot', 'codex', 'cursor-agent', 'opencode', 'windsurf']

/** Shown for folders without `.specify/`: runs `specify init` on request. */
export function InitPanel({ projectId, path }: { projectId: number; path: string }): React.JSX.Element {
  const [integration, setIntegration] = useState('claude')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; output: string }>()
  const init = async (): Promise<void> => {
    setBusy(true)
    setResult(await window.api.env.specifyInit(projectId, integration).finally(() => setBusy(false)))
  }
  return (
    <div className="max-w-2xl mx-auto mt-[12vh] space-y-4 px-6">
      <h2 className="text-lg font-semibold">Spec Kit is not set up in this repository</h2>
      <p className="text-dim">
        <code>{path}</code> has no <code>.specify/</code> folder. Initializing adds Spec Kit's templates, scripts and the agent commands for the chosen
        integration (<code>specify init --here</code>). Existing files stay; review the changes with git afterwards.
      </p>
      <div className="flex items-center gap-2">
        <label className="text-dim">Integration</label>
        <select value={integration} onChange={(e) => setIntegration(e.target.value)} className="bg-raised border border-line rounded px-2 py-1 outline-none">
          {INTEGRATIONS.map((i) => (
            <option key={i}>{i}</option>
          ))}
        </select>
        <button onClick={init} disabled={busy} className="rounded-md bg-accent text-white px-3 py-1 disabled:opacity-50">
          {busy ? 'Initializing…' : 'Initialize Spec Kit'}
        </button>
      </div>
      {result && (
        <pre className={`max-h-80 overflow-auto rounded-md border p-3 text-[11px] whitespace-pre-wrap select-text ${result.ok ? 'border-line' : 'border-[#eb5757] text-[#eb5757]'}`}>
          {result.output.trim() || (result.ok ? 'Done.' : 'Failed.')}
        </pre>
      )}
    </div>
  )
}
