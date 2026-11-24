export interface ProjectMeta {
  id: string;
  name: string;
  main: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  thumbnail?: boolean;
}

export interface ScadLog {
  errors: string[];
  warnings: string[];
  echoes: string[];
  raw: string;
}

export interface MeshStats {
  triangles: number;
  min: number[];
  max: number[];
  size: number[];
  volume: number;
  surfaceArea: number;
}

export interface PreviewState {
  status: 'idle' | 'rendering' | 'ok' | 'error';
  kind?: '3d' | '2d' | 'empty' | 'error';
  version: number;
  file?: string;
  stats?: MeshStats | null;
  log?: ScadLog;
  durationMs?: number;
  updatedAt?: string;
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; input: any; result?: string; isError?: boolean; images?: number };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  ts: string;
  text?: string;
  images?: string[];
  blocks?: Block[];
  done?: boolean;
  error?: string;
  costUsd?: number;
  durationMs?: number;
  commit?: string | null;
}

export type ParamValue = number | boolean | string | number[];
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

export interface FileEntry {
  path: string;
  size: number;
  mtime: string;
}

export interface Commit {
  sha: string;
  short: string;
  date: string;
  message: string;
  files: string[];
}

export interface ExportFormat {
  id: string;
  label: string;
  ext: string;
  description: string;
  dim: '3d' | '2d' | 'any';
}

export interface Status {
  version: string;
  openscad: { bin: string; version: string; manifold: boolean; formats: string[]; xvfb: boolean };
  claude: 'api-key' | 'oauth-token' | 'none';
  dataDir: string;
  exportFormats: ExportFormat[];
  importExtensions: string[];
}

export interface PublicSettings {
  model: string;
  customInstructions: string;
  printerProfile: string;
  anthropicApiKey: string;
  claudeOAuthToken: string;
  auth: { mode: 'api-key' | 'oauth-token' | 'none'; source: string };
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...init } = opts;
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) };
    init.method = init.method ?? 'POST';
  }
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (res.status === 401 && !path.startsWith('/api/login')) {
    window.dispatchEvent(new Event('splat:unauthorized'));
  }
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (body as any)?.error ?? String(body) ?? res.statusText);
  return body as T;
}

export const P = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]+,/, ''));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
