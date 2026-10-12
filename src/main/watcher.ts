import { watch, type FSWatcher } from 'node:fs'

const RELEVANT =
  /^(specs|work-items|\.specify|docs)([/\\\\]|$)|^\.studio[/\\\\]worktrees[/\\\\][^/\\\\]+[/\\\\]specs[/\\\\]|(^|[/\\\\])(CLAUDE|GEMINI|AGENTS)\.md$|^\.(claude|gemini)[/\\\\]|^package\.json$/

/** Watches a repo recursively and calls onChange (debounced) when Spec Kit relevant files change. */
export function watchProject(path: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined
  let w: FSWatcher
  try {
    w = watch(path, { recursive: true }, (_event, file) => {
      if (file && !RELEVANT.test(file)) return
      clearTimeout(timer)
      timer = setTimeout(onChange, 150)
    })
  } catch {
    return () => {} // folder missing; snapshot will report it
  }
  w.on('error', () => w.close())
  return () => {
    clearTimeout(timer)
    w.close()
  }
}
