import { spawn, type SpawnOptions } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
  durationMs: number;
}

export interface RunOptions extends SpawnOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  input?: string | Buffer;
  maxOutput?: number;
}

/** Spawn a process and collect its output. Never throws for non-zero exit. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs, signal, input, maxOutput = 4 * 1024 * 1024, ...spawnOpts } = opts;
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    let child;
    try {
      child = spawn(cmd, args, { ...spawnOpts, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err), killed: false, durationMs: 0 });
      return;
    }
    const kill = () => {
      killed = true;
      child.kill('SIGKILL');
    };
    const timer = timeoutMs ? setTimeout(kill, timeoutMs) : undefined;
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout!.on('data', (d: Buffer) => {
      if (stdout.length < maxOutput) stdout += d.toString();
    });
    child.stderr!.on('data', (d: Buffer) => {
      if (stderr.length < maxOutput) stderr += d.toString();
    });
    child.on('error', (err) => {
      stderr += String(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve({ code, stdout, stderr, killed, durationMs: Date.now() - started });
    });
    if (input !== undefined) child.stdin!.end(input);
    else child.stdin!.end();
  });
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'project'
  );
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
