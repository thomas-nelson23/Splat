import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { OPENSCAD_PATH, RENDER_TIMEOUT_MS, TMP_DIR } from './config.js';
import { run } from './util.js';

export interface Capabilities {
  bin: string;
  version: string;
  manifold: boolean;
  formats: string[];
  xvfb: boolean;
}

let caps: Capabilities | null = null;

async function exists(cmd: string) {
  const r = await run('sh', ['-c', `command -v "$1"`, 'sh', cmd]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function capabilities(): Promise<Capabilities> {
  if (caps) return caps;
  const bin = process.env.OPENSCAD_BIN ?? (await exists('openscad-nightly')) ?? (await exists('openscad')) ?? 'openscad';
  const v = await run(bin, ['--version']);
  const help = await run(bin, ['--help']);
  const helpText = help.stdout + help.stderr;
  const formatLine = helpText.match(/file extension specifies the type:([\s\S]*?)[.(]/)?.[1] ?? '';
  const formats = formatLine.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^[a-z0-9]+$/.test(s));
  caps = {
    bin,
    version: (v.stdout + v.stderr).trim().replace(/^OpenSCAD version\s*/i, '') || 'unknown',
    manifold: /--backend/.test(helpText) && /manifold/i.test(helpText),
    formats,
    xvfb: !!(await exists('xvfb-run')),
  };
  return caps;
}

export type ParamValue = number | boolean | string | number[];
export type ParamOverrides = Record<string, ParamValue>;

function defineArgs(params?: ParamOverrides): string[] {
  if (!params) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(k)) continue;
    let lit: string;
    if (typeof v === 'string') lit = JSON.stringify(v);
    else if (Array.isArray(v)) lit = `[${v.map(Number).join(',')}]`;
    else lit = String(v);
    out.push('-D', `${k}=${lit}`);
  }
  return out;
}

export interface ScadLog {
  errors: string[];
  warnings: string[];
  echoes: string[];
  raw: string;
}

export function parseLog(raw: string): ScadLog {
  const lines = raw.split('\n');
  return {
    errors: lines.filter((l) => /^(ERROR|Parser error|CGAL error|Current top level object is empty)/i.test(l.trim()) || /\bERROR:/.test(l)),
    warnings: lines.filter((l) => /^WARNING:/.test(l.trim())),
    echoes: lines.filter((l) => /^ECHO:/.test(l.trim())),
    raw,
  };
}

export interface RenderOutput {
  ok: boolean;
  kind: '3d' | '2d' | 'empty' | 'error';
  file?: string;
  log: ScadLog;
  durationMs: number;
  cancelled?: boolean;
}

function baseArgs(c: Capabilities) {
  return c.manifold ? ['--backend=manifold'] : [];
}

const scadEnv = () => ({ ...process.env, OPENSCADPATH: OPENSCAD_PATH });

/**
 * Render a .scad file to a mesh (binary STL) or, for 2D designs, an SVG.
 * `outBase` is a path without extension.
 */
export async function render(
  cwd: string,
  file: string,
  outBase: string,
  params?: ParamOverrides,
  signal?: AbortSignal,
): Promise<RenderOutput> {
  const c = await capabilities();
  const stl = `${outBase}.stl`;
  const r = await run(c.bin, [...baseArgs(c), '-o', stl, '--export-format', 'binstl', ...defineArgs(params), file], {
    cwd,
    env: scadEnv(),
    timeoutMs: RENDER_TIMEOUT_MS,
    signal,
  });
  const log = parseLog(r.stdout + r.stderr);
  if (r.killed) return { ok: false, kind: 'error', log, durationMs: r.durationMs, cancelled: signal?.aborted };
  if (/not a 3D object/i.test(log.raw)) {
    const svg = `${outBase}.svg`;
    const r2 = await run(c.bin, [...baseArgs(c), '-o', svg, ...defineArgs(params), file], { cwd, env: scadEnv(), timeoutMs: RENDER_TIMEOUT_MS, signal });
    const log2 = parseLog(r2.stdout + r2.stderr);
    const ok = r2.code === 0 && fss.existsSync(svg);
    return { ok, kind: ok ? '2d' : 'error', file: ok ? svg : undefined, log: log2, durationMs: r.durationMs + r2.durationMs };
  }
  if (/top level object is empty/i.test(log.raw)) return { ok: true, kind: 'empty', log, durationMs: r.durationMs };
  const ok = r.code === 0 && fss.existsSync(stl);
  return { ok, kind: ok ? '3d' : 'error', file: ok ? stl : undefined, log, durationMs: r.durationMs };
}

/** Export directly with OpenSCAD in a given format (extension). */
export async function exportNative(cwd: string, file: string, out: string, format: string, params?: ParamOverrides) {
  const c = await capabilities();
  const fmtArgs = format === 'stl' ? ['--export-format', 'binstl'] : format === 'asciistl' ? ['--export-format', 'asciistl'] : [];
  const r = await run(c.bin, [...baseArgs(c), '-o', out, ...fmtArgs, ...defineArgs(params), file], {
    cwd,
    env: scadEnv(),
    timeoutMs: RENDER_TIMEOUT_MS,
  });
  return { ok: r.code === 0 && fss.existsSync(out), log: parseLog(r.stdout + r.stderr) };
}

export const VIEWS: Record<string, string> = {
  iso: '0,0,0,55,0,25,0',
  front: '0,0,0,90,0,0,0',
  back: '0,0,0,90,0,180,0',
  left: '0,0,0,90,0,270,0',
  right: '0,0,0,90,0,90,0',
  top: '0,0,0,0,0,0,0',
  bottom: '0,0,0,180,0,0,0',
  iso_back: '0,0,0,55,0,205,0',
};

/** Render PNG snapshots of an existing mesh file from several angles. */
export async function snapshots(meshFile: string, views: string[], size = 640): Promise<{ view: string; png: Buffer }[]> {
  const c = await capabilities();
  const work = await fs.mkdtemp(path.join(TMP_DIR, 'snap-'));
  try {
    const wrapper = path.join(work, 'view.scad');
    const isSvg = meshFile.endsWith('.svg');
    await fs.writeFile(wrapper, isSvg ? `linear_extrude(1) import(${JSON.stringify(meshFile)});\n` : `color("#f2a33a") import(${JSON.stringify(meshFile)});\n`);
    const out: { view: string; png: Buffer }[] = [];
    for (const view of views) {
      const cam = VIEWS[view] ?? VIEWS.iso;
      const png = path.join(work, `${view}.png`);
      const args = [
        ...baseArgs(c),
        '-o', png,
        `--imgsize=${size},${Math.round(size * 0.75)}`,
        `--camera=${cam}`,
        '--viewall', '--autocenter',
        '--view=axes,scales',
        '--colorscheme=Tomorrow',
        '--projection=p',
        '--render=true',
        wrapper,
      ];
      const r = c.xvfb
        ? await run('xvfb-run', ['-a', '-s', '-screen 0 1280x1024x24', c.bin, ...args], { cwd: work, env: scadEnv(), timeoutMs: 120_000 })
        : await run(c.bin, args, { cwd: work, env: scadEnv(), timeoutMs: 120_000 });
      if (fss.existsSync(png)) out.push({ view, png: await fs.readFile(png) });
      else throw new Error(`snapshot failed: ${(r.stderr || r.stdout).slice(-800)}`);
    }
    return out;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** Mesh statistics from a binary STL. */
export function stlStats(buf: Buffer) {
  if (buf.length < 84) return null;
  const n = buf.readUInt32LE(80);
  if (84 + n * 50 !== buf.length) return null; // not binary STL
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let vol = 0;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    const v: number[][] = [];
    for (let j = 0; j < 3; j++) {
      const p = [buf.readFloatLE(o + j * 12), buf.readFloatLE(o + j * 12 + 4), buf.readFloatLE(o + j * 12 + 8)];
      for (let k = 0; k < 3; k++) {
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
      v.push(p);
    }
    const [a, b, c] = v;
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    area += Math.hypot(cr[0], cr[1], cr[2]) / 2;
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    triangles: n,
    min: min.map(r3),
    max: max.map(r3),
    size: max.map((m, k) => r3(m - min[k])),
    volume: r3(Math.abs(vol)),
    surfaceArea: r3(area),
  };
}

export function hashInputs(parts: (string | Buffer)[]) {
  const h = crypto.createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Customizer parameter parsing (OpenSCAD customizer comment syntax)
// ---------------------------------------------------------------------------

export interface ScadParam {
  name: string;
  type: 'number' | 'boolean' | 'string' | 'vector';
  value: ParamValue;
  group: string;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string | number; label: string }[];
  maxLength?: number;
}

function parseLiteral(src: string): { type: ScadParam['type']; value: ParamValue } | null {
  const s = src.trim();
  if (/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return { type: 'number', value: Number(s) };
  if (s === 'true' || s === 'false') return { type: 'boolean', value: s === 'true' };
  if (/^"(?:[^"\\]|\\.)*"$/.test(s)) {
    try {
      return { type: 'string', value: JSON.parse(s) as string };
    } catch {
      return { type: 'string', value: s.slice(1, -1) };
    }
  }
  const vec = s.match(/^\[([^\[\]]*)\]$/);
  if (vec) {
    const items = vec[1].split(',').map((x) => x.trim()).filter(Boolean);
    if (items.length && items.every((x) => /^-?(\d+\.?\d*|\.\d+)$/.test(x))) return { type: 'vector', value: items.map(Number) };
  }
  return null;
}

export function parseParams(source: string): ScadParam[] {
  const params: ScadParam[] = [];
  let group = 'Parameters';
  let depth = 0;
  let prevComment: string | undefined;
  let inBlockComment = false;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    const groupMatch = line.match(/^\/\*\s*\[([^\]]+)\]\s*\*\/$/);
    if (groupMatch && depth === 0) {
      group = groupMatch[1].trim();
      prevComment = undefined;
      continue;
    }
    if (line.startsWith('/*') && !line.includes('*/')) {
      inBlockComment = true;
      continue;
    }
    if (depth === 0 && /^(module|function)\s/.test(line)) break;
    if (line.startsWith('//')) {
      prevComment = line.replace(/^\/\/\s?/, '');
      continue;
    }
    const m = depth === 0 ? line.match(/^([A-Za-z_$][\w$]*)\s*=\s*([^;]+);\s*(?:\/\/\s*(.*))?$/) : null;
    if (m && group.toLowerCase() !== 'hidden') {
      const lit = parseLiteral(m[2]);
      if (lit) {
        const p: ScadParam = { name: m[1], ...lit, group, description: prevComment };
        const spec = m[3]?.match(/^\[(.*)\]\s*(.*)$/);
        if (spec) {
          const body = spec[1].trim();
          if (spec[2]) p.description = spec[2];
          const range = body.match(/^(-?[\d.]+)\s*:\s*(-?[\d.]+)(?:\s*:\s*(-?[\d.]+))?$/);
          if (range && (p.type === 'number' || p.type === 'vector')) {
            if (range[3] !== undefined) {
              p.min = Number(range[1]);
              p.step = Number(range[2]);
              p.max = Number(range[3]);
            } else {
              p.min = Number(range[1]);
              p.max = Number(range[2]);
            }
          } else if (/^-?[\d.]+$/.test(body) && p.type === 'number') {
            p.max = Number(body);
            p.min = 0;
          } else if (/^\d+$/.test(body) && p.type === 'string') {
            p.maxLength = Number(body);
          } else if (body) {
            p.options = body.split(',').map((opt) => {
              const [v, label] = opt.split(':').map((x) => x.trim());
              const value = p.type === 'number' ? Number(v) : v.replace(/^"|"$/g, '');
              return { value, label: label ?? String(value) };
            });
          }
        } else if (m[3]) {
          p.description = m[3];
        }
        params.push(p);
      }
    }
    prevComment = undefined;
    const stripped = rawLine.replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '');
    for (const ch of stripped) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return params;
}
