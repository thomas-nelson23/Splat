import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECTS_DIR } from './config.js';
import { HttpError, slugify } from './util.js';
import * as git from './git.js';

export interface ProjectMeta {
  id: string;
  name: string;
  main: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileEntry {
  path: string;
  size: number;
  mtime: string;
}

const STARTER = `// New Splat project. Ask Claude in the chat to design something,
// or edit this file directly. Units are millimetres.

include <BOSL2/std.scad>

/* [Size] */
width = 40;   // [10:1:200]
depth = 30;   // [10:1:200]
height = 15;  // [5:1:100]
rounding = 3; // [0:0.5:10]

cuboid([width, depth, height], rounding = rounding, except = BOT, anchor = BOT);
`;

const STARTER_NO_BOSL = `// New Splat project. Ask Claude in the chat to design something,
// or edit this file directly. Units are millimetres.

/* [Size] */
width = 40;   // [10:1:200]
depth = 30;   // [10:1:200]
height = 15;  // [5:1:100]

cube([width, depth, height]);
`;

export function projectDir(id: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new HttpError(400, 'bad project id');
  return path.join(PROJECTS_DIR, id);
}

export function stateDir(id: string) {
  const d = path.join(projectDir(id), '.splat');
  fss.mkdirSync(d, { recursive: true });
  return d;
}

/** Resolve a path inside a project, refusing anything that escapes it or touches internals. */
export function safePath(id: string, rel: string) {
  const root = projectDir(id);
  const p = path.resolve(root, rel.replace(/^\/+/, ''));
  if (p !== root && !p.startsWith(root + path.sep)) throw new HttpError(400, 'path escapes project');
  const first = path.relative(root, p).split(path.sep)[0];
  if (first === '.git' || first === '.splat') throw new HttpError(400, 'internal path');
  return p;
}

export async function readMeta(id: string): Promise<ProjectMeta> {
  try {
    const raw = await fs.readFile(path.join(projectDir(id), 'project.json'), 'utf8');
    const meta = JSON.parse(raw) as ProjectMeta;
    return { ...meta, id, main: meta.main || 'main.scad' };
  } catch {
    if (!fss.existsSync(projectDir(id))) throw new HttpError(404, 'project not found');
    const st = await fs.stat(projectDir(id));
    return { id, name: id, main: 'main.scad', createdAt: st.birthtime.toISOString(), updatedAt: st.mtime.toISOString() };
  }
}

export async function writeMeta(meta: ProjectMeta) {
  const { id, ...rest } = meta;
  await fs.writeFile(path.join(projectDir(id), 'project.json'), JSON.stringify({ ...rest }, null, 2) + '\n');
}

export async function touch(id: string) {
  const meta = await readMeta(id);
  meta.updatedAt = new Date().toISOString();
  await writeMeta(meta);
}

export async function listProjects(): Promise<(ProjectMeta & { thumbnail: boolean })[]> {
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const meta = await readMeta(e.name);
      out.push({ ...meta, thumbnail: fss.existsSync(path.join(projectDir(e.name), '.splat', 'thumbnail.png')) });
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function uniqueId(name: string) {
  const base = slugify(name);
  let id = base;
  while (fss.existsSync(path.join(PROJECTS_DIR, id))) id = `${base}-${crypto.randomBytes(2).toString('hex')}`;
  return id;
}

export async function createProject(name: string, opts: { description?: string; bosl2: boolean; content?: string }) {
  const id = uniqueId(name);
  const dir = path.join(PROJECTS_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const meta: ProjectMeta = { id, name: name.trim() || 'Untitled', main: 'main.scad', description: opts.description, createdAt: now, updatedAt: now };
  await writeMeta(meta);
  await fs.writeFile(path.join(dir, '.gitignore'), '.splat/\n');
  await fs.writeFile(path.join(dir, 'main.scad'), opts.content ?? (opts.bosl2 ? STARTER : STARTER_NO_BOSL));
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dir, 'assets', '.gitkeep'), '');
  await git.initRepo(dir);
  await git.commitAll(dir, 'Create project');
  return meta;
}

export async function duplicateProject(id: string, name: string) {
  const src = projectDir(id);
  const newId = uniqueId(name);
  const dest = path.join(PROJECTS_DIR, newId);
  await fs.cp(src, dest, { recursive: true, filter: (p) => !p.includes(`${path.sep}.splat${path.sep}chat`) && !p.endsWith(`${path.sep}.splat${path.sep}session.json`) });
  const meta = await readMeta(newId);
  const now = new Date().toISOString();
  await writeMeta({ ...meta, id: newId, name, createdAt: now, updatedAt: now });
  await git.commitAll(dest, `Duplicate of ${meta.name}`);
  return readMeta(newId);
}

export async function deleteProject(id: string) {
  const dir = projectDir(id);
  // Soft delete: move to .trash so nothing is lost by a mis-click.
  const trash = path.join(PROJECTS_DIR, '.trash');
  await fs.mkdir(trash, { recursive: true });
  await fs.rename(dir, path.join(trash, `${id}-${Date.now()}`));
}

export async function listFiles(id: string): Promise<FileEntry[]> {
  const root = projectDir(id);
  const out: FileEntry[] = [];
  async function walk(dir: string) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (dir === root && (e.name === '.git' || e.name === '.splat')) continue;
      if (e.name === '.gitkeep') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const st = await fs.stat(full);
        out.push({ path: path.relative(root, full).split(path.sep).join('/'), size: st.size, mtime: st.mtime.toISOString() });
      }
    }
  }
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
