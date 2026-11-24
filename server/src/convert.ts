import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { PYTHON, SCRIPTS_DIR, TMP_DIR } from './config.js';
import { run } from './util.js';
import { capabilities, exportNative, type ParamOverrides } from './openscad.js';
import { readMeta, projectDir } from './projects.js';

async function py(args: string[], timeoutMs = 300_000) {
  const r = await run(PYTHON, ['-I', path.join(SCRIPTS_DIR, 'convert.py'), ...args], { timeoutMs });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') || 'conversion failed');
  return r.stdout;
}

export const convert = {
  step2stl: (src: string, dst: string, tol = 0.05) => py(['step2stl', src, dst, String(tol)]),
  mesh2stl: (src: string, dst: string) => py(['mesh2stl', src, dst]),
  stl2mesh: (src: string, dst: string) => py(['stl2mesh', src, dst]),
  stl2step: (src: string, dst: string) => py(['stl2step', src, dst]),
  zipdir: (src: string, dst: string) => py(['zipdir', src, dst]),
  info: async (src: string) => JSON.parse((await py(['info', src])).trim().split('\n').pop()!),
};

export interface ExportFormat {
  id: string;
  label: string;
  ext: string;
  description: string;
  dim: '3d' | '2d' | 'any';
}

export const EXPORT_FORMATS: ExportFormat[] = [
  { id: '3mf', label: '3MF', ext: '3mf', dim: '3d', description: 'Best for OrcaSlicer and modern slicers (units, metadata).' },
  { id: 'stl', label: 'STL (binary)', ext: 'stl', dim: '3d', description: 'Universal mesh format every slicer reads.' },
  { id: 'asciistl', label: 'STL (ASCII)', ext: 'stl', dim: '3d', description: 'Text STL, for tools that need it.' },
  { id: 'step', label: 'STEP', ext: 'step', dim: '3d', description: 'Faceted solid for CAD tools (Fusion, FreeCAD, Onshape).' },
  { id: 'obj', label: 'OBJ', ext: 'obj', dim: '3d', description: 'Mesh for Blender and renderers.' },
  { id: 'glb', label: 'glTF (GLB)', ext: 'glb', dim: '3d', description: 'Web / AR viewers.' },
  { id: 'ply', label: 'PLY', ext: 'ply', dim: '3d', description: 'Mesh with simple structure.' },
  { id: 'off', label: 'OFF', ext: 'off', dim: '3d', description: 'Geomview mesh format.' },
  { id: 'amf', label: 'AMF', ext: 'amf', dim: '3d', description: 'Legacy additive manufacturing format.' },
  { id: 'svg', label: 'SVG', ext: 'svg', dim: '2d', description: '2D designs: laser cutting, vinyl, drawings.' },
  { id: 'dxf', label: 'DXF', ext: 'dxf', dim: '2d', description: '2D designs for CAD / CNC / laser.' },
  { id: 'pdf', label: 'PDF', ext: 'pdf', dim: '2d', description: '2D drawing as PDF.' },
  { id: 'png', label: 'PNG render', ext: 'png', dim: 'any', description: 'Picture of the model.' },
  { id: 'scad', label: 'OpenSCAD source (.zip)', ext: 'zip', dim: 'any', description: 'All project files.' },
];

/**
 * Produce an export file for a project. Returns the path of a temp file the caller must delete,
 * plus a suggested filename.
 */
export async function exportProject(
  id: string,
  formatId: string,
  params: ParamOverrides | undefined,
  opts: { cwd?: string } = {},
): Promise<{ file: string; filename: string; cleanup: () => Promise<void> }> {
  const fmt = EXPORT_FORMATS.find((f) => f.id === formatId);
  if (!fmt) throw new Error(`unknown format ${formatId}`);
  const meta = await readMeta(id);
  const cwd = opts.cwd ?? projectDir(id);
  const work = await fs.mkdtemp(path.join(TMP_DIR, 'export-'));
  const cleanup = () => fs.rm(work, { recursive: true, force: true });
  const base = meta.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || id;
  const out = path.join(work, `${base}.${fmt.ext}`);
  const caps = await capabilities();
  const fail = (msg: string) => {
    void cleanup();
    throw new Error(msg);
  };
  const native = async (format: string, file = out) => {
    const r = await exportNative(cwd, meta.main, file, format, params);
    if (!r.ok) fail(r.log.errors.join('\n') || r.log.raw.split('\n').slice(-6).join('\n') || 'OpenSCAD export failed');
    return file;
  };
  const viaStl = async () => native('stl', path.join(work, 'mesh.stl'));

  try {
    switch (fmt.id) {
      case 'scad':
        await convert.zipdir(cwd, out);
        break;
      case 'stl':
      case 'asciistl':
      case 'amf':
      case 'svg':
      case 'dxf':
      case 'pdf':
        await native(fmt.id);
        break;
      case 'off':
        await native('off');
        break;
      case '3mf':
        if (caps.formats.includes('3mf')) {
          const r = await exportNative(cwd, meta.main, out, '3mf', params);
          if (!r.ok) await convert.stl2mesh(await viaStl(), out);
        } else await convert.stl2mesh(await viaStl(), out);
        break;
      case 'obj':
        if (caps.formats.includes('obj')) await native('obj');
        else await convert.stl2mesh(await viaStl(), out);
        break;
      case 'glb':
      case 'ply':
        await convert.stl2mesh(await viaStl(), out);
        break;
      case 'step':
        await convert.stl2step(await viaStl(), out);
        break;
      case 'png': {
        const { snapshots } = await import('./openscad.js');
        const [shot] = await snapshots(await viaStl(), ['iso'], 1600);
        await fs.writeFile(out, shot.png);
        break;
      }
    }
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { file: out, filename: path.basename(out), cleanup };
}

export const IMPORT_EXTS = ['stl', 'obj', 'off', '3mf', 'amf', 'ply', 'glb', 'gltf', 'step', 'stp', 'svg', 'dxf', 'png', 'dat', 'csv', 'scad', 'json', 'ttf', 'otf'];

/**
 * Store an uploaded file in assets/ and, where OpenSCAD can't read it directly, convert it to STL.
 * Returns the paths written and an OpenSCAD snippet that uses the file.
 */
export async function importFile(id: string, tmpPath: string, originalName: string) {
  const dir = projectDir(id);
  const ext = path.extname(originalName).slice(1).toLowerCase();
  if (!IMPORT_EXTS.includes(ext)) throw new Error(`.${ext} files are not supported`);
  const safeName = path.basename(originalName).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_');
  const assets = path.join(dir, 'assets');
  await fs.mkdir(assets, { recursive: true });
  let dest = path.join(assets, safeName);
  if (ext === 'scad') dest = path.join(dir, safeName);
  await fs.copyFile(tmpPath, dest);
  const rel = (p: string) => path.relative(dir, p).split(path.sep).join('/');
  const written = [rel(dest)];
  let usable = dest;
  const stlFor = (src: string) => {
    const base = src.replace(/\.\w+$/, '');
    return fss.existsSync(`${base}.stl`) ? `${base}_${ext}.stl` : `${base}.stl`;
  };
  const caps = await capabilities();
  const nativeMesh = ['stl', 'off', 'amf', '3mf'].concat(caps.formats.includes('obj') ? ['obj'] : []);
  if (['step', 'stp'].includes(ext)) {
    usable = stlFor(dest);
    await convert.step2stl(dest, usable);
    written.push(rel(usable));
  } else if (['obj', 'ply', 'glb', 'gltf'].includes(ext) && !nativeMesh.includes(ext)) {
    usable = stlFor(dest);
    await convert.mesh2stl(dest, usable);
    written.push(rel(usable));
  }
  const u = rel(usable);
  let snippet: string;
  let info: unknown = null;
  if (['stl', 'off', 'amf', '3mf', 'obj', 'ply', 'glb', 'gltf', 'step', 'stp'].includes(ext)) {
    snippet = `import("${u}", convexity = 10);`;
    try {
      info = await convert.info(usable);
    } catch {
      /* stats are optional */
    }
  } else if (['svg', 'dxf'].includes(ext)) snippet = `linear_extrude(height = 2) import("${u}");`;
  else if (['png', 'dat', 'csv'].includes(ext)) snippet = `surface(file = "${u}", center = true);`;
  else if (['ttf', 'otf'].includes(ext)) snippet = `use <${u}>  // then: text("Hello", font = "<font family name>");`;
  else if (ext === 'scad') snippet = `use <${u}>`;
  else snippet = `// ${u}`;
  return { written, file: u, snippet, info };
}
