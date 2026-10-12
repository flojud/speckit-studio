import { useEffect, useState } from 'react'

/** Loads a project file; `rev` bumps on file-system changes to trigger a reload. */
export function useFile(projectId: number, rel: string | undefined, rev: number): string | null | undefined {
  const [text, setText] = useState<string | null>()
  useEffect(() => {
    if (!rel) return setText(undefined)
    let alive = true
    window.api.readFile(projectId, rel).then((t) => alive && setText(t))
    return () => {
      alive = false
    }
  }, [projectId, rel, rev])
  return text
}
