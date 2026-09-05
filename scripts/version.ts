import { execFileSync } from 'node:child_process';
export function codeVersion(): string {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return commit + (dirty ? '-dirty' : '');
  } catch {
    return 'uncommitted-dirty';
  }
}
