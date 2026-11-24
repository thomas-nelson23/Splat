import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'));
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const LIBRARIES_DIR = path.join(DATA_DIR, 'libraries');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const PORT = Number(process.env.PORT ?? 8080);
export const WEB_DIR = path.resolve(process.env.WEB_DIR ?? path.join(here, '..', '..', 'web', 'dist'));
export const SCRIPTS_DIR = path.resolve(process.env.SCRIPTS_DIR ?? path.join(here, '..', '..', 'scripts'));
export const PYTHON = process.env.PYTHON ?? 'python3';
export const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_SECONDS ?? 600) * 1000;
export const APP_VERSION = process.env.APP_VERSION ?? 'dev';

/** Extra OpenSCAD library dirs baked into the image (BOSL2 etc.) plus the user's own. */
export const OPENSCAD_PATH = [LIBRARIES_DIR, ...(process.env.OPENSCAD_LIBS ?? '/opt/openscad-libs').split(':')]
  .filter(Boolean)
  .join(':');

for (const d of [DATA_DIR, PROJECTS_DIR, LIBRARIES_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });
