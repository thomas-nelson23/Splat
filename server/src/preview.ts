import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { projectDir, readMeta, stateDir } from './projects.js';
import { render, stlStats, type ParamOverrides, type ScadLog } from './openscad.js';
import { broadcast } from './hub.js';

export interface PreviewState {
  status: 'idle' | 'rendering' | 'ok' | 'error';
  kind?: '3d' | '2d' | 'empty' | 'error';
  version: number;
  file?: string;
  stats?: ReturnType<typeof stlStats>;
  log?: ScadLog;
  durationMs?: number;
  updatedAt?: string;
}

class Preview {
  state: PreviewState = { status: 'idle', version: 0 };
  private abort: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private waiters: ((s: PreviewState) => void)[] = [];
  private pending = false;

  constructor(public id: string) {
    const statePath = path.join(stateDir(id), 'preview.json');
    try {
      this.state = { ...JSON.parse(fss.readFileSync(statePath, 'utf8')), status: 'ok' };
    } catch {
      /* first time */
    }
  }

  watch() {
    if (this.watcher) return;
    const root = projectDir(this.id);
    this.watcher = watch(root, {
      ignored: (p: string) => {
        const rel = path.relative(root, p);
        return rel.startsWith('.git') || rel.startsWith('.splat') || rel.includes(`${path.sep}.git`);
      },
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    this.watcher.on('all', (_evt, p) => {
      broadcast(this.id, { type: 'files-changed', path: path.relative(root, p) });
      if (/\.(scad|stl|off|obj|3mf|amf|svg|dxf|dat|png|json|csv)$/i.test(p)) this.schedule(250);
    });
  }

  async params(): Promise<ParamOverrides> {
    try {
      return JSON.parse(await fs.readFile(path.join(stateDir(this.id), 'params.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  async setParams(p: ParamOverrides) {
    await fs.writeFile(path.join(stateDir(this.id), 'params.json'), JSON.stringify(p, null, 2));
    this.schedule(0);
  }

  schedule(delay = 250) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.renderNow(), delay);
  }

  /** Wait for the next completed render (scheduling one if nothing is in flight). */
  next(): Promise<PreviewState> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      if (this.state.status !== 'rendering' && !this.timer) this.schedule(0);
    });
  }

  async renderNow(): Promise<PreviewState> {
    this.timer = null;
    if (this.abort) {
      // A render is in flight: cancel it; the latest file state wins.
      this.pending = true;
      this.abort.abort();
      return this.state;
    }
    const ac = new AbortController();
    this.abort = ac;
    this.state = { ...this.state, status: 'rendering' };
    broadcast(this.id, { type: 'render', state: this.state });
    const meta = await readMeta(this.id);
    const dir = projectDir(this.id);
    const out = path.join(stateDir(this.id), 'preview-next');
    let result;
    try {
      result = await render(dir, meta.main, out, await this.params(), ac.signal);
    } catch (err) {
      result = { ok: false, kind: 'error' as const, log: { errors: [String(err)], warnings: [], echoes: [], raw: String(err) }, durationMs: 0 };
    }
    this.abort = null;
    if (result.cancelled || this.pending) {
      this.pending = false;
      return this.renderNow();
    }
    const version = this.state.version + 1;
    let file: string | undefined;
    let stats: PreviewState['stats'];
    if (result.ok && result.file) {
      const ext = path.extname(result.file);
      file = `preview${ext}`;
      await fs.rename(result.file, path.join(stateDir(this.id), file));
      if (ext === '.stl') stats = stlStats(await fs.readFile(path.join(stateDir(this.id), file)));
    }
    this.state = {
      status: result.ok ? 'ok' : 'error',
      kind: result.kind,
      version,
      file: file ?? (result.ok ? undefined : this.state.file),
      stats: stats ?? (result.ok ? undefined : this.state.stats),
      log: result.log,
      durationMs: result.durationMs,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(stateDir(this.id), 'preview.json'), JSON.stringify(this.state));
    broadcast(this.id, { type: 'render', state: this.state });
    const w = this.waiters.splice(0);
    for (const fn of w) fn(this.state);
    return this.state;
  }

  close() {
    void this.watcher?.close();
    this.abort?.abort();
  }
}

const previews = new Map<string, Preview>();

export function preview(id: string) {
  let p = previews.get(id);
  if (!p) {
    p = new Preview(id);
    previews.set(id, p);
    p.watch();
  }
  return p;
}

export function dropPreview(id: string) {
  previews.get(id)?.close();
  previews.delete(id);
}
