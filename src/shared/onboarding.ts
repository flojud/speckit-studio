import type { OnboardingPreferences, OnboardingStep } from './types.ts'
import { isNewerVersion } from './semver.ts'

/**
 * The onboarding guide. To document a new feature, append a step tagged with the app version (package.json)
 * that ships it; users whose lastSeenVersion is older get it via the sidebar "What's New" badge.
 */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'welcome',
    title: 'Spec-Driven Development Cockpit',
    category: 'Getting Started',
    icon: 'compass',
    version: '0.1.0',
    summary: 'Speckit Studio is a local cockpit for GitHub Spec Kit repositories: write specs, plan, and let AI agents implement them.',
    highlights: [
      'Files in your repository are the single source of truth – the app never invents state',
      '100% local: no cloud account, no telemetry',
      'Drive coding agents step by step through the spec lifecycle'
    ]
  },
  {
    id: 'projects',
    title: 'Projects & Git Repositories',
    category: 'Core Concepts',
    icon: 'folder-git',
    version: '0.1.0',
    summary: 'Every project is a local Git repository. Add one with "+ Add project" and switch between projects in the sidebar.',
    highlights: [
      'Spec Kit (.specify/) is detected automatically',
      'Not initialized yet? Run specify init directly from the app',
      'Branches, merge state and worktrees show up as badges on specs'
    ]
  },
  {
    id: 'dashboard',
    title: 'Agile Dashboard & Views',
    category: 'Agile & PM',
    icon: 'kanban',
    version: '0.1.0',
    summary: 'Opening a project shows its Dashboard: progress, milestones, epics and recent agent runs at a glance.',
    highlights: [
      'Board: Kanban of all specs and work items by phase',
      'Roadmap & Calendar: milestones and epics over time',
      'Wiki and Constitution: project knowledge and principles as Markdown'
    ],
    action: { label: 'Go to Dashboard', target: 'dashboard' }
  },
  {
    id: 'work-items',
    title: 'Non-Code Work Items',
    category: 'Work Items',
    icon: 'file-text',
    version: '0.1.0',
    summary: 'Not everything is code. Work items hold business plans, marketing tasks, research notes and architecture records.',
    highlights: [
      'Stored as Markdown in work-items/ next to your specs',
      'Agents can draft and refine them with a plain prompt',
      'Link them to epics and milestones like specs'
    ]
  },
  {
    id: 'spec-lifecycle',
    title: 'Spec Kit Development Lifecycle',
    category: 'Workflow',
    icon: 'workflow',
    version: '0.1.0',
    summary: 'Each feature moves through the Spec Kit phases, each one a command run by your agent.',
    highlights: [
      'Specify → Clarify → Plan → Tasks → Implement → Analyze',
      'Phase status is derived from the files in specs/ on every read',
      'Answer clarification questions and track tasks right in the spec view'
    ],
    action: { label: 'View Constitution', target: 'constitution' }
  },
  {
    id: 'agents',
    title: 'Agent Control & Permissions',
    category: 'AI Agents',
    icon: 'cpu',
    version: '0.1.0',
    summary: 'Agents connect over the Agent Client Protocol (ACP) – Claude Code, Google Antigravity, Gemini CLI, Codex and more.',
    highlights: [
      'Pick model and reasoning effort globally or per phase',
      'Review and approve tool permissions as the agent asks',
      'Follow every run live in the run console'
    ],
    action: { label: 'Go to Settings', target: 'settings' }
  },
  {
    id: 'shortcuts',
    title: 'Keyboard First & Power Tools',
    category: 'Power Tools',
    icon: 'command',
    version: '0.1.0',
    summary: 'Everything is a keystroke away. The Command Palette finds views, specs, work items and actions.',
    highlights: [
      '⌘K / Ctrl+K opens the Command Palette',
      'C new spec · W new work item · G D dashboard · G B board',
      'Agents, permissions and this guide live in Settings'
    ],
    action: { label: 'Open Command Palette', target: 'palette' }
  },
  {
    id: 'project-agent',
    title: 'Project Agent, Skills & MCP Servers',
    category: 'AI Agents',
    icon: 'cpu',
    version: '0.2.0',
    summary: 'Agent Config now controls which agent runs a project and what it can use: skills with their files, and MCP servers.',
    highlights: [
      'Assign a project agent, model, effort and standing instructions in the Project agent bar',
      'Expand a skill to edit, add or delete its helper files',
      'Add, edit and switch MCP servers in .mcp.json – enabled ones are passed to every run',
      'Health badges flag broken JSON, missing commands and unknown binaries'
    ]
  }
]

/** Steps introduced after lastSeenVersion; all steps when the user never acknowledged the guide. */
export const getUnreadSteps = (catalog: OnboardingStep[], lastSeenVersion?: string): OnboardingStep[] =>
  lastSeenVersion ? catalog.filter((s) => isNewerVersion(s.version, lastSeenVersion)) : catalog

/** FR-002: only a true first run (no record, no projects) opens the guide on its own. */
export const shouldAutoOpenOnboarding = ({ prefs, projectCount }: { prefs: OnboardingPreferences | null; projectCount: number }): boolean =>
  prefs === null && projectCount === 0
