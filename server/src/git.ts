import { run } from './util.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Splat',
  GIT_AUTHOR_EMAIL: 'splat@localhost',
  GIT_COMMITTER_NAME: 'Splat',
  GIT_COMMITTER_EMAIL: 'splat@localhost',
};

export async function git(cwd: string, args: string[], input?: string) {
  const r = await run('git', ['-c', 'core.quotepath=off', '-c', 'safe.directory=*', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    input,
  });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

export async function initRepo(dir: string) {
  await git(dir, ['init', '-q', '-b', 'main']);
}

/** Commit everything if something changed. Returns the new sha or null. */
export async function commitAll(dir: string, message: string): Promise<string | null> {
  await git(dir, ['add', '-A']);
  const status = await git(dir, ['status', '--porcelain']);
  if (!status.trim()) return null;
  await git(dir, ['commit', '-q', '-m', message]);
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

export interface Commit {
  sha: string;
  short: string;
  date: string;
  message: string;
  files: string[];
}

export async function log(dir: string, limit = 200): Promise<Commit[]> {
  let out: string;
  try {
    out = await git(dir, ['log', `-n${limit}`, '--name-only', '--format=%x1e%H%x1f%h%x1f%aI%x1f%B%x1f']);
  } catch {
    return [];
  }
  return out
    .split('\x1e')
    .filter((s) => s.trim())
    .map((chunk) => {
      const [sha, short, date, message, rest] = chunk.split('\x1f');
      return {
        sha,
        short,
        date,
        message: message.trim(),
        files: (rest ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
      };
    });
}

export async function headSha(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ['rev-parse', 'HEAD'])).trim();
  } catch {
    return null;
  }
}

/** Export a tree at a revision into a directory (for previewing old versions). */
export async function exportTree(dir: string, sha: string, dest: string) {
  const archive = await run('sh', ['-c', `git -c safe.directory='*' archive --format=tar "$1" | tar -x -C "$2"`, 'sh', sha, dest], { cwd: dir });
  if (archive.code !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
}

/** Make the working tree match `sha` (keeping history) and commit that as a new version. */
export async function restore(dir: string, sha: string, message: string) {
  await git(dir, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.']);
  // Remove tracked files that do not exist in the target revision, then check out the target tree.
  const current = (await git(dir, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  const target = new Set((await git(dir, ['ls-tree', '-r', '--name-only', sha])).split('\n').filter(Boolean));
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  for (const f of current) if (!target.has(f)) await fs.rm(path.join(dir, f), { force: true });
  await git(dir, ['checkout', sha, '--', '.']);
  return commitAll(dir, message);
}

export async function diff(dir: string, sha: string) {
  return git(dir, ['show', '--format=', '--stat', '--patch', sha]);
}
