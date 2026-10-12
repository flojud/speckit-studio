export interface QuickReplies {
  recommended?: string
  options: { letter: string; label: string }[]
}

/** Extracts the multiple-choice options of a Spec Kit `/clarify` question (options table + optional recommendation). */
export function parseQuickReplies(text: string): QuickReplies | undefined {
  const options = [...text.matchAll(/^\|\s*([A-E])\s*\|\s*(.+?)\s*\|\s*$/gm)].map((m) => ({ letter: m[1], label: m[2] }))
  if (options.length < 2) return undefined
  const recommended = text.match(/\*\*Recommended:\*\*\s*Option\s+([A-E])\b/)?.[1]
  return { ...(recommended ? { recommended } : {}), options }
}

/** Number of CRITICAL rows in a `/analyze` findings table. */
export const countCritical = (report: string): number => report.match(/\|\s*CRITICAL\s*\|/g)?.length ?? 0
