import { useEffect, useRef, useState } from 'react'
import type { OnboardingStep, StepActionTarget, StepIconName } from '../../../shared/types'

export interface OnboardingModalProps {
  /** Must not be empty. */
  steps: OnboardingStep[]
  /** Set in "What's New" mode: shows the badge and a link to the full guide. */
  onViewAll?: () => void
  /** completed = "Get Started" on the last step; otherwise skipped/closed. */
  onClose: (completed: boolean) => void
  onAction: (target: StepActionTarget) => void
}

const ICONS: Record<StepIconName, React.ReactNode> = {
  compass: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3z" />
    </>
  ),
  'folder-git': (
    <>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
      <circle cx="12" cy="13" r="2" />
      <path d="M14 13h3M7 13h3" />
    </>
  ),
  kanban: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M8 7v7M12 7v4M16 7v9" />
    </>
  ),
  'file-text': (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </>
  ),
  workflow: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="2" />
      <rect x="13" y="13" width="8" height="8" rx="2" />
      <path d="M7 11v4a2 2 0 0 0 2 2h4" />
    </>
  ),
  cpu: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </>
  ),
  command: <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
}

export function OnboardingModal({ steps, onViewAll, onClose, onAction }: OnboardingModalProps): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const last = steps.length - 1
  const step = steps[Math.min(index, last)]

  const next = (): void => (index >= last ? onClose(true) : setIndex(Math.min(index + 1, last)))
  const prev = (): void => setIndex((i) => Math.max(i - 1, 0))

  useEffect(() => ref.current?.focus(), [])

  // Capture phase + stopPropagation keeps the app's global shortcuts (⌘K, Esc, C, W…) inactive while the guide is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (e.key === 'Escape') onClose(false)
      else if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') prev()
      // Enter on a focused button already clicks it.
      else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) next()
      else if (e.key === 'Tab' && ref.current) {
        const els = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled])')]
        const i = els.indexOf(document.activeElement as HTMLElement)
        const to = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : i === els.length - 1 ? 0 : i + 1
        e.preventDefault()
        els[to]?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4" onClick={() => onClose(false)}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        className="w-[560px] max-w-full max-h-full flex flex-col rounded-xl border border-line bg-panel shadow-2xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 pt-4 text-[11px] text-dim">
          {onViewAll && <span className="rounded bg-accent/20 text-accent px-1.5 py-0.5 font-medium">What's New</span>}
          <span className="rounded bg-raised px-1.5 py-0.5 uppercase tracking-wide">{step.category}</span>
          <span className="ml-auto">
            Step {index + 1} of {steps.length}
          </span>
          <button type="button" onClick={() => onClose(false)} aria-label="Close guide" className="ml-2 rounded px-1 text-dim hover:text-fg hover:bg-raised">
            ✕
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
          <div className="flex items-center gap-3">
            <span className="grid place-items-center w-10 h-10 shrink-0 rounded-lg bg-accent/15 text-accent">
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {ICONS[step.icon]}
              </svg>
            </span>
            <h2 id="onboarding-title" className="text-[17px] font-semibold text-fg">
              {step.title}
            </h2>
          </div>
          <p className="text-[13px] text-dim">{step.summary}</p>
          <ul className="space-y-1.5 text-[13px]">
            {step.highlights.map((h) => (
              <li key={h} className="flex gap-2">
                <span className="text-accent">•</span>
                <span>{h}</span>
              </li>
            ))}
          </ul>
          {step.action && (
            <button type="button" onClick={() => onAction(step.action!.target)} className="rounded-md border border-line px-2.5 py-1 text-[13px] text-accent hover:bg-raised">
              {step.action.label} →
            </button>
          )}
        </div>

        <div className="flex justify-center gap-1.5 pb-3" role="tablist" aria-label="Guide progress">
          {steps.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`Step ${i + 1}: ${s.title}`}
              onClick={() => setIndex(i)}
              className={`h-1.5 rounded-full transition-all ${i === index ? 'w-4 bg-accent' : 'w-1.5 bg-line hover:bg-dim'}`}
            />
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          <button type="button" onClick={() => onClose(false)} className="rounded-md px-2.5 py-1 text-[13px] text-dim hover:text-fg hover:bg-raised">
            Skip
          </button>
          {onViewAll && (
            <button type="button" onClick={onViewAll} className="rounded-md px-2.5 py-1 text-[13px] text-dim hover:text-fg hover:bg-raised">
              View full guide
            </button>
          )}
          <button
            type="button"
            disabled={index === 0}
            onClick={prev}
            className="ml-auto rounded-md px-2.5 py-1 text-[13px] text-dim hover:text-fg hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Previous
          </button>
          <button type="button" onClick={next} className="rounded-md bg-accent text-white px-3 py-1 text-[13px] font-medium">
            {index >= last ? 'Get Started' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
