/** Compares "MAJOR.MINOR.PATCH" strings (pre-release/build suffixes ignored): 1 if a > b, -1 if a < b, 0 if equal. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] => v.replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1
  return 0
}

export const isNewerVersion = (target: string, base: string): boolean => compareSemver(target, base) > 0
