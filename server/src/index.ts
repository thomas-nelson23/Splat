import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import http from 'node:http';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { APP_VERSION, PORT, TMP_DIR, WEB_DIR, DATA_DIR } from './config.js';
import { HttpError } from './util.js';
import * as projects from './projects.js';
import * as git from './git.js';
import { preview, dropPreview } from './preview.js';
import { capabilities, parseParams, render, stlStats, type ParamOverrides } from './openscad.js';
import { EXPORT_FORMATS, exportProject, importFile, IMPORT_EXTS } from './convert.js';
import { chat, dropChat, testAgent } from './claude.js';
import { publicSettings, updateSettings, claudeAuth, agentKind, agentReady } from './settings.js';
import { subscribe, send, broadcast } from './hub.js';
import { authEnabled, checkPassword, clearSession, isAuthed, makeToken, parseCookies, readToken, requireAuth, setSession } from './auth.js';

const app = express();
app.set('trust proxy', true);
app.use(cookieParser());
app.use(express.json({ limit: '40mb' }));
app.use(express.text({ limit: '20mb', type: ['text/plain', 'application/x-openscad'] }));
const upload = multer({ dest: path.join(TMP_DIR, 'uploads'), limits: { fileSize: 512 * 1024 * 1024 } });

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res))
    .then((v) => {
      if (v !== undefined && !res.headersSent) res.json(v);
    })
    .catch(next);
};
const pid = (req: Request) => {
  const id = String(req.params.id);
  projects.projectDir(id);
  if (!fss.existsSync(projects.projectDir(id))) throw new HttpError(404, 'project not found');
  return id;
};

// ---------------------------------------------------------------- auth & status
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/auth', (req, res) => res.json({ required: authEnabled(), authed: isAuthed(req.cookies) }));
app.post('/api/login', (req, res) => {
  if (!authEnabled() || checkPassword(String(req.body?.password ?? ''))) {
    setSession(res);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'wrong password' });
});
app.post('/api/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// Tokenised downloads (for "Open in OrcaSlicer", which fetches the file itself without cookies).
app.get(
  '/dl/:token/:filename',
  h(async (req, res) => {
    const t = readToken<{ p: string; f: string; params?: ParamOverrides }>(String(req.params.token));
    if (!t) throw new HttpError(403, 'link expired');
    const out = await exportProject(t.p, t.f, t.params);
    res.download(out.file, out.filename, { dotfiles: 'allow' }, () => void out.cleanup());
  }),
);

app.use('/api', requireAuth);

app.get(
  '/api/status',
  h(async () => {
    const caps = await capabilities();
    return {
      version: APP_VERSION,
      openscad: caps,
      claude: claudeAuth().mode,
      agent: agentKind(),
      agentReady: agentReady(),
      dataDir: DATA_DIR,
      exportFormats: EXPORT_FORMATS,
      importExtensions: IMPORT_EXTS,
    };
  }),
);

app.get('/api/settings', (_req, res) => res.json(publicSettings()));
app.put(
  '/api/settings',
  h(async (req) => {
    const b = req.body ?? {};
    const pick = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : undefined);
    const patch: Record<string, string | undefined> = {
      model: pick('model'),
      customInstructions: pick('customInstructions'),
      printerProfile: pick('printerProfile'),
      anthropicApiKey: pick('anthropicApiKey'),
      claudeOAuthToken: pick('claudeOAuthToken'),
      agent: b.agent === 'hermes' || b.agent === 'claude' ? b.agent : undefined,
      hermesUrl: pick('hermesUrl'),
      hermesApiKey: pick('hermesApiKey'),
      hermesModel: pick('hermesModel'),
    };
    // Setting one credential type clears the other so it is obvious which is used.
    if (patch.anthropicApiKey) patch.claudeOAuthToken = '';
    if (patch.claudeOAuthToken) patch.anthropicApiKey = '';
    updateSettings(patch);
    return publicSettings();
  }),
);
app.post('/api/settings/test', h((req) => testAgent(req.body?.agent === 'hermes' || req.body?.agent === 'claude' ? req.body.agent : undefined)));

// ---------------------------------------------------------------- projects
app.get('/api/projects', h(() => projects.listProjects()));
app.post(
  '/api/projects',
  h(async (req) => {
    const caps = await capabilities();
    void caps;
    const hasBosl = fss.existsSync('/opt/openscad-libs/BOSL2') || fss.existsSync(path.join(DATA_DIR, 'libraries', 'BOSL2'));
    return projects.createProject(String(req.body?.name ?? 'Untitled'), { description: req.body?.description, bosl2: hasBosl });
  }),
);
app.get('/api/projects/:id', h((req) => projects.readMeta(pid(req))));
app.patch(
  '/api/projects/:id',
  h(async (req) => {
    const id = pid(req);
    const meta = await projects.readMeta(id);
    if (typeof req.body?.name === 'string' && req.body.name.trim()) meta.name = req.body.name.trim();
    if (typeof req.body?.description === 'string') meta.description = req.body.description;
    if (typeof req.body?.main === 'string') {
      projects.safePath(id, req.body.main);
      meta.main = req.body.main;
    }
    meta.updatedAt = new Date().toISOString();
    await projects.writeMeta(meta);
    await git.commitAll(projects.projectDir(id), 'Update project settings');
    preview(id).schedule(0);
    return meta;
  }),
);
app.delete(
  '/api/projects/:id',
  h(async (req) => {
    const id = pid(req);
    dropChat(id);
    dropPreview(id);
    await projects.deleteProject(id);
    return { ok: true };
  }),
);
app.post('/api/projects/:id/duplicate', h((req) => projects.duplicateProject(pid(req), String(req.body?.name ?? 'Copy'))));

// thumbnails are captured by the browser from the 3D view
app.get('/api/projects/:id/thumbnail', (req, res, next) => {
  try {
    const f = path.join(projects.projectDir(String(req.params.id)), '.splat', 'thumbnail.png');
    if (!fss.existsSync(f)) return res.status(404).end();
    res.sendFile(f, { dotfiles: 'allow' });
  } catch (e) {
    next(e);
  }
});
app.put(
  '/api/projects/:id/thumbnail',
  h(async (req) => {
    const id = pid(req);
    const data = String(req.body?.dataUrl ?? '').replace(/^data:image\/png;base64,/, '');
    await fs.writeFile(path.join(projects.stateDir(id), 'thumbnail.png'), Buffer.from(data, 'base64'));
    return { ok: true };
  }),
);

// ---------------------------------------------------------------- files
app.get('/api/projects/:id/files', h((req) => projects.listFiles(pid(req))));
app.get('/api/projects/:id/file', (req, res, next) => {
  try {
    const id = pid(req);
    const p = projects.safePath(id, String(req.query.path ?? ''));
    if (!fss.existsSync(p)) throw new HttpError(404, 'file not found');
    if (req.query.download) res.download(p, path.basename(p), { dotfiles: 'allow' });
    else res.sendFile(p, { dotfiles: 'allow' });
  } catch (e) {
    next(e);
  }
});
app.put(
  '/api/projects/:id/file',
  h(async (req) => {
    const id = pid(req);
    const rel = String(req.query.path ?? '');
    const p = projects.safePath(id, rel);
    const content = typeof req.body === 'string' ? req.body : String(req.body?.content ?? '');
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
    let commit: string | null = null;
    if (req.query.commit !== '0') commit = await git.commitAll(projects.projectDir(id), String(req.query.message || `Edit ${rel}`));
    if (commit) broadcast(id, { type: 'history-changed' });
    await projects.touch(id);
    return { ok: true, commit };
  }),
);
app.delete(
  '/api/projects/:id/file',
  h(async (req) => {
    const id = pid(req);
    const rel = String(req.query.path ?? '');
    await fs.rm(projects.safePath(id, rel), { force: true });
    const commit = await git.commitAll(projects.projectDir(id), `Delete ${rel}`);
    if (commit) broadcast(id, { type: 'history-changed' });
    return { ok: true };
  }),
);
app.post(
  '/api/projects/:id/rename-file',
  h(async (req) => {
    const id = pid(req);
    const from = projects.safePath(id, String(req.body?.from ?? ''));
    const to = projects.safePath(id, String(req.body?.to ?? ''));
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    await git.commitAll(projects.projectDir(id), `Rename ${req.body.from} to ${req.body.to}`);
    broadcast(id, { type: 'history-changed' });
    return { ok: true };
  }),
);
app.post(
  '/api/projects/:id/import',
  upload.array('files', 20),
  h(async (req) => {
    const id = pid(req);
    const files = (req.files as Express.Multer.File[]) ?? [];
    const results = [];
    for (const f of files) {
      try {
        results.push({ name: f.originalname, ok: true, ...(await importFile(id, f.path, f.originalname)) });
      } catch (err) {
        results.push({ name: f.originalname, ok: false, error: String((err as Error).message ?? err) });
      } finally {
        await fs.rm(f.path, { force: true });
      }
    }
    const names = results.filter((r) => r.ok).map((r) => r.name);
    if (names.length) {
      await git.commitAll(projects.projectDir(id), `Import ${names.join(', ')}`);
      broadcast(id, { type: 'history-changed' });
    }
    return results;
  }),
);

// ---------------------------------------------------------------- preview & params
app.get(
  '/api/projects/:id/preview',
  h((req) => {
    const p = preview(pid(req));
    if (p.state.version === 0 && p.state.status !== 'rendering') p.schedule(0);
    return p.state;
  }),
);
app.get('/api/projects/:id/preview/model', (req, res, next) => {
  try {
    const id = pid(req);
    const p = preview(id);
    if (!p.state.file) throw new HttpError(404, 'no render yet');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(projects.stateDir(id), p.state.file), { dotfiles: 'allow' });
  } catch (e) {
    next(e);
  }
});
app.post(
  '/api/projects/:id/render',
  h(async (req) => {
    const p = preview(pid(req));
    const next = p.next();
    p.schedule(0);
    return next;
  }),
);
app.get(
  '/api/projects/:id/params',
  h(async (req) => {
    const id = pid(req);
    const meta = await projects.readMeta(id);
    let src = '';
    try {
      src = await fs.readFile(projects.safePath(id, meta.main), 'utf8');
    } catch {
      /* missing main */
    }
    return { params: parseParams(src), overrides: await preview(id).params() };
  }),
);
app.put(
  '/api/projects/:id/params',
  h(async (req) => {
    const id = pid(req);
    await preview(id).setParams((req.body?.overrides ?? {}) as ParamOverrides);
    return { ok: true };
  }),
);
/** Write the current customizer values back into the main file as new defaults. */
app.post(
  '/api/projects/:id/params/apply',
  h(async (req) => {
    const id = pid(req);
    const meta = await projects.readMeta(id);
    const file = projects.safePath(id, meta.main);
    const p = preview(id);
    const overrides = await p.params();
    let src = await fs.readFile(file, 'utf8');
    for (const [k, v] of Object.entries(overrides)) {
      const lit = typeof v === 'string' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.join(', ')}]` : String(v);
      const re = new RegExp(`^(\\s*${k.replace(/\$/g, '\\$')}\\s*=\\s*)([^;]+)(;.*)$`, 'm');
      src = src.replace(re, (_m, a, _b, c) => `${a}${lit}${c}`);
    }
    await fs.writeFile(file, src);
    await p.setParams({});
    const commit = await git.commitAll(projects.projectDir(id), `Set parameters: ${Object.entries(overrides).map(([k, v]) => `${k}=${v}`).join(', ').slice(0, 120)}`);
    broadcast(id, { type: 'history-changed' });
    return { ok: true, commit };
  }),
);

// ---------------------------------------------------------------- history
app.get('/api/projects/:id/history', h((req) => git.log(projects.projectDir(pid(req)))));
app.get(
  '/api/projects/:id/history/:sha',
  h(async (req) => ({ diff: await git.diff(projects.projectDir(pid(req)), String(req.params.sha).replace(/[^a-f0-9]/g, '')) })),
);
app.post(
  '/api/projects/:id/history/:sha/restore',
  h(async (req) => {
    const id = pid(req);
    const sha = String(req.params.sha).replace(/[^a-f0-9]/g, '');
    if (chat(id).running) throw new HttpError(409, 'Claude is working; stop it before restoring');
    const commit = await git.restore(projects.projectDir(id), sha, `Restore version ${sha.slice(0, 7)}`);
    broadcast(id, { type: 'history-changed' });
    preview(id).schedule(0);
    return { ok: true, commit };
  }),
);
app.post(
  '/api/projects/:id/commit',
  h(async (req) => {
    const id = pid(req);
    const commit = await git.commitAll(projects.projectDir(id), String(req.body?.message || 'Save version'));
    if (commit) broadcast(id, { type: 'history-changed' });
    return { commit };
  }),
);
/** Render an old version without touching the working tree. */
app.get('/api/projects/:id/history/:sha/model', async (req, res, next) => {
  const work = path.join(TMP_DIR, `hist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const id = pid(req);
    const sha = String(req.params.sha).replace(/[^a-f0-9]/g, '');
    const cacheDir = path.join(projects.stateDir(id), 'history');
    await fs.mkdir(cacheDir, { recursive: true });
    for (const ext of ['stl', 'svg']) {
      const cached = path.join(cacheDir, `${sha}.${ext}`);
      if (fss.existsSync(cached)) {
        res.setHeader('X-Model-Kind', ext === 'stl' ? '3d' : '2d');
        return res.sendFile(cached, { dotfiles: 'allow' });
      }
    }
    await fs.mkdir(work, { recursive: true });
    await git.exportTree(projects.projectDir(id), sha, work);
    let main = 'main.scad';
    try {
      main = JSON.parse(await fs.readFile(path.join(work, 'project.json'), 'utf8')).main || main;
    } catch {
      /* default */
    }
    const r = await render(work, main, path.join(work, 'out'));
    if (!r.ok || !r.file) throw new HttpError(422, r.log.errors.join('\n') || 'that version does not render');
    const ext = path.extname(r.file).slice(1);
    const cached = path.join(cacheDir, `${sha}.${ext}`);
    await fs.copyFile(r.file, cached);
    res.setHeader('X-Model-Kind', r.kind);
    if (ext === 'stl') res.setHeader('X-Model-Stats', JSON.stringify(stlStats(await fs.readFile(cached))));
    res.sendFile(cached, { dotfiles: 'allow' });
  } catch (e) {
    next(e);
  } finally {
    void fs.rm(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- export
app.get('/api/formats', (_req, res) => res.json(EXPORT_FORMATS));
app.get(
  '/api/projects/:id/export',
  h(async (req, res) => {
    const id = pid(req);
    const params = req.query.params === '0' ? undefined : await preview(id).params();
    const out = await exportProject(id, String(req.query.format ?? 'stl'), params);
    await new Promise<void>((resolve) => res.download(out.file, out.filename, { dotfiles: 'allow' }, () => resolve()));
    await out.cleanup();
  }),
);
app.post(
  '/api/projects/:id/export-link',
  h(async (req) => {
    const id = pid(req);
    const format = String(req.body?.format ?? '3mf');
    const meta = await projects.readMeta(id);
    const fmt = EXPORT_FORMATS.find((f) => f.id === format);
    if (!fmt) throw new HttpError(400, 'unknown format');
    const token = makeToken({ p: id, f: format, params: await preview(id).params() }, 15 * 60);
    const filename = `${meta.name.replace(/[^\w\-]+/g, '_') || id}.${fmt.ext}`;
    return { path: `/dl/${token}/${encodeURIComponent(filename)}` };
  }),
);

// ---------------------------------------------------------------- chat
app.get(
  '/api/projects/:id/chat',
  h(async (req) => {
    const c = chat(pid(req));
    await c.load();
    return c.snapshot();
  }),
);
app.post(
  '/api/projects/:id/chat',
  h(async (req) => {
    const id = pid(req);
    preview(id); // make sure the watcher is live so edits re-render
    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    return chat(id).send(String(req.body?.text ?? ''), images);
  }),
);
app.post('/api/projects/:id/chat/stop', h((req) => (chat(pid(req)).stop(), { ok: true })));
app.post('/api/projects/:id/chat/reset', h(async (req) => (await chat(pid(req)).reset(), { ok: true })));
app.get('/api/projects/:id/chat/upload/:name', (req, res, next) => {
  try {
    const id = pid(req);
    const name = path.basename(String(req.params.name));
    res.sendFile(path.join(projects.stateDir(id), 'uploads', name), { dotfiles: 'allow' });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------- static web app
if (fss.existsSync(WEB_DIR)) {
  app.use(express.static(WEB_DIR, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/|dl\/|ws).*/, (_req, res) => res.sendFile(path.join(WEB_DIR, 'index.html'), { dotfiles: 'allow' }));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : String(err);
  if (status >= 500) console.error(err);
  if (!res.headersSent) res.status(status).json({ error: message });
});

// ---------------------------------------------------------------- websocket
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/ws' || !isAuthed(parseCookies(req.headers.cookie))) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const project = url.searchParams.get('project');
    let id: string | null = null;
    if (project) {
      try {
        projects.projectDir(project);
        id = project;
        preview(project);
      } catch {
        id = null;
      }
    }
    subscribe(ws, id);
    send(ws, { type: 'hello', version: APP_VERSION });
    const ping = setInterval(() => ws.ping(), 25_000);
    ws.on('close', () => clearInterval(ping));
  });
});

server.listen(PORT, () => {
  void capabilities().then((c) => {
    console.log(`Splat ${APP_VERSION} listening on :${PORT}`);
    console.log(`  data: ${DATA_DIR}`);
    console.log(`  OpenSCAD: ${c.bin} ${c.version}${c.manifold ? ' (manifold)' : ''}`);
    console.log(`  Chat agent: ${agentKind()}${agentKind() === 'claude' ? ` (auth: ${claudeAuth().mode})` : ''}`);
    if (!authEnabled()) console.log('  APP_PASSWORD not set: the UI is open to anyone who can reach this port.');
  });
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0));
