import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const MARK = '__STUDIO_PATH__'

export const parseShellPath = (out: string): string | undefined => out.match(new RegExp(`${MARK}(.*?)${MARK}`))?.[1] || undefined

/** Shell entries first, then any extra entries of the current PATH, without duplicates. */
export const mergePath = (current: string | undefined, shell: string): string =>
  [...new Set([...shell.split(':'), ...(current ?? '').split(':')].filter(Boolean))].join(':')

/**
 * Apps launched from Finder/Dock get a minimal PATH, so npx/claude/specify would be missing.
 * Adopt the login shell's PATH (3 s max; on failure keep the current one).
 */
export async function adoptShellPath(): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const { stdout } = await exec(process.env.SHELL || '/bin/zsh', ['-ilc', `echo ${MARK}` + '${PATH}' + MARK], { timeout: 3000 })
    const shell = parseShellPath(stdout)
    if (shell) process.env.PATH = mergePath(process.env.PATH, shell)
  } catch {
    // keep PATH as is
  }
}

export interface ToolStatus {
  id: string
  required: boolean
  version?: string
  hint: string
}

const TOOLS: { id: string; cmd: string; required: boolean; hint: string }[] = [
  { id: 'git', cmd: 'git', required: true, hint: 'xcode-select --install' },
  { id: 'npx', cmd: 'npx', required: true, hint: 'brew install node  (needed for the Claude ACP adapter)' },
  { id: 'uv', cmd: 'uv', required: false, hint: 'brew install uv  (runs Spec Kit without installing it)' },
  { id: 'specify', cmd: 'specify', required: false, hint: 'uv tool install specify-cli --from git+https://github.com/github/spec-kit.git' },
  { id: 'claude', cmd: 'claude', required: false, hint: 'npm install -g @anthropic-ai/claude-code, then run `claude` once to sign in' },
  { id: 'agy', cmd: 'agy', required: false, hint: 'Install Antigravity from https://antigravity.google' },
  { id: 'gh', cmd: 'gh', required: false, hint: 'brew install gh  (for "Create PR")' }
]

export const parseVersion = (out: string): string | undefined => out.match(/\d+\.\d+(?:\.\d+)?/)?.[0]

export const checkTools = (): Promise<ToolStatus[]> =>
  Promise.all(
    TOOLS.map(async ({ id, cmd, required, hint }) => {
      const out = await exec(cmd, ['--version'], { timeout: 10000 }).then((r) => r.stdout + r.stderr, () => undefined)
      return { id, required, hint, version: out === undefined ? undefined : (parseVersion(out) ?? 'found') }
    })
  )

/** Runs `specify init` in a folder; falls back to uvx when `specify` is not installed. */
export async function specifyInit(cwd: string, integration: string): Promise<{ ok: boolean; output: string }> {
  if (!/^[a-z][a-z0-9-]*$/.test(integration)) throw new Error(`Invalid integration: ${integration}`)
  const args = ['init', '--here', '--integration', integration, '--force']
  const hasSpecify = await exec('specify', ['--version']).then(() => true, () => false)
  const [cmd, argv] = hasSpecify ? ['specify', args] : ['uvx', ['--from', 'git+https://github.com/github/spec-kit.git', 'specify', ...args]]
  try {
    const r = await exec(cmd, argv as string[], { cwd, timeout: 5 * 60_000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } })
    return { ok: true, output: r.stdout + r.stderr }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string }
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` || err.message }
  }
}
