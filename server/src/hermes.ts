/**
 * Hermes Agent (Nous Research) as an alternative chat backend.
 *
 * Splat talks to a Hermes gateway's OpenAI-compatible API server (`API_SERVER_ENABLED=true`,
 * `POST /v1/chat/completions`, `Authorization: Bearer <API_SERVER_KEY>`). Hermes usually runs in
 * its own container, so its tools cannot touch Splat's project folder. Instead Splat sends the
 * project's current source files with every turn, Hermes answers with whole-file fenced blocks
 * (```openscad file=main.scad), and Splat writes them, renders, and feeds any render errors back
 * for up to MAX_FIX_ROUNDS automatic fix attempts.
 */
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listFiles, readMeta, safePath, stateDir } from './projects.js';
import { renderReport } from './render-report.js';
import { capabilities } from './openscad.js';
import { getSettings, hermesConfig } from './settings.js';

type ToolBlock = { type: 'tool'; id: string; name: string; input: unknown; result?: string; isError?: boolean };
type Block = { type: 'text'; text: string } | { type: 'thinking'; text: string } | ToolBlock;
interface Msg {
  role: 'user' | 'assistant' | 'system';
  text?: string;
  images?: string[];
  blocks?: Block[];
  done?: boolean;
  error?: string;
}
interface ImageInput {
  mediaType: string;
  data: string;
}
type OpenAIContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
type OpenAIMessage = { role: 'system' | 'user' | 'assistant'; content: OpenAIContent };

const MAX_FIX_ROUNDS = 3;
const MAX_FILE_CHARS = 60_000;
const MAX_CONTEXT_CHARS = 150_000;
const HISTORY_TURNS = 20;
const TEXT_EXT = /\.(scad|json|csv|dat|txt|md)$/i;
/** A fenced block that names the file it replaces: ```openscad file=parts/lid.scad */
const FILE_BLOCK = /```[^\n`]*?\bfile=["']?([^\s"'`]+)["']?[^\n]*\n([\s\S]*?)\n?```/g;
/** An unfinished file block at the end of a stream, hidden until it closes. */
const OPEN_FILE_BLOCK = /```[^\n`]*?\bfile=[^\n]*(\n[\s\S]*)?$/;

export function hermesReady() {
  return !!hermesConfig().url;
}

function headers(sessionId?: string) {
  const { key } = hermesConfig();
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) h.Authorization = `Bearer ${key}`;
  if (sessionId) h['X-Hermes-Session-Id'] = sessionId;
  return h;
}

async function systemPrompt(projectId: string) {
  const meta = await readMeta(projectId);
  const caps = await capabilities();
  const s = getSettings();
  const files = (await listFiles(projectId)).filter((f) => TEXT_EXT.test(f.path) && f.path !== 'project.json');
  const assets = (await listFiles(projectId)).filter((f) => f.path.startsWith('assets/')).map((f) => f.path);
  let budget = MAX_CONTEXT_CHARS;
  const sources: string[] = [];
  for (const f of files) {
    if (budget <= 0) {
      sources.push(`(${f.path} not shown: context budget used up)`);
      continue;
    }
    let text = await fs.readFile(safePath(projectId, f.path), 'utf8').catch(() => '');
    if (text.length > MAX_FILE_CHARS) text = `${text.slice(0, MAX_FILE_CHARS)}\n// … truncated`;
    budget -= text.length;
    sources.push(`\`\`\`${f.path.endsWith('.scad') ? 'openscad' : ''} file=${f.path}\n${text}\n\`\`\``);
  }
  return `You are the modeling assistant inside Splat, a self-hosted web app where the user designs 3D-printable parts in OpenSCAD by chatting with you. The user sees a live 3D preview of \`${meta.main}\` next to this chat; it re-renders whenever a file changes.

Project: "${meta.name}". The project files live inside Splat, not on your machine, so do not try to read or write them with your own terminal or file tools. Change them only like this:

- To create or replace a file, reply with its COMPLETE new contents in one fenced block whose info string names the file, for example:
\`\`\`openscad file=${meta.main}
// whole file here
\`\`\`
- Always send whole files, never diffs or fragments. Paths are relative to the project root. Leave project.json, .git and .splat alone.
- Splat writes the files, renders \`${meta.main}\` with OpenSCAD ${caps.version}${caps.manifold ? ' (Manifold backend)' : ''} and saves a version. If the render fails, Splat sends you the errors so you can fix them.
- Libraries available: BOSL2 (\`include <BOSL2/std.scad>\`, threading, screws, gears, hinges…) and the user's own library folder.
- Imported files are in assets/ (${assets.length ? assets.join(', ') : 'none yet'}); use import() for them. STEP and OBJ imports have a sibling .stl.

How to work:
- Units are millimetres, Z is up, the part sits on Z=0 in its best print orientation unless the user says otherwise.
- Clean parametric code: key dimensions as top-level variables before any module, annotated for the customizer, e.g. \`wall = 2; // [0.8:0.2:5] Wall thickness\`, grouped with \`/* [Group name] */\`, internals under \`/* [Hidden] */\`.
- Mostly functional parts and enclosures: FDM printability (overhangs ≤45°, walls ≥1.2 mm, 0.2–0.3 mm clearance for fits, chamfer bottom edges, real hardware sizes such as M3 heat-set inserts).
- Use $fa/$fs so curves are smooth but renders stay quick (e.g. \`$fa = 2; $fs = 0.4;\`).
- Keep the prose short: say what you built or changed and the key dimensions. The user is looking at the model, not reading code.
${s.printerProfile ? `\nUser's printer / slicer setup:\n${s.printerProfile}\n` : ''}${s.customInstructions ? `\nUser's standing instructions:\n${s.customInstructions}\n` : ''}
Current project files (the source of truth, including any hand edits since your last reply):
${sources.join('\n\n') || '(no source files yet)'}`;
}

/** Text the user sees: prose without the file blocks (Splat shows those as "Wrote <file>" chips). */
export function visibleText(raw: string) {
  return raw.replace(FILE_BLOCK, '').replace(OPEN_FILE_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function fileBlocks(raw: string) {
  const out: { path: string; content: string }[] = [];
  for (const m of raw.matchAll(FILE_BLOCK)) out.push({ path: m[1], content: m[2].endsWith('\n') ? m[2] : `${m[2]}\n` });
  return out;
}

async function imagePart(projectId: string, name: string) {
  try {
    const data = await fs.readFile(path.join(stateDir(projectId), 'uploads', name));
    const ext = path.extname(name).slice(1);
    return { type: 'image_url' as const, image_url: { url: `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${data.toString('base64')}` } };
  } catch {
    return null;
  }
}

/** Earlier turns as plain chat messages: the user's words, and Hermes's prose plus a note of the files it wrote. */
function historyMessages(history: Msg[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const m of history.slice(-HISTORY_TURNS * 2)) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text || '(image)' });
    else if (m.role === 'assistant') {
      const text = (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n');
      const wrote = (m.blocks ?? []).filter((b): b is ToolBlock => b.type === 'tool' && b.name === 'splat_write').map((b) => (b.input as { path: string }).path);
      out.push({ role: 'assistant', content: `${text}${wrote.length ? `\n\n(wrote ${wrote.join(', ')})` : ''}` || '(no reply)' });
    }
  }
  return out;
}

function sessionId(projectId: string) {
  const f = path.join(stateDir(projectId), 'hermes-session.json');
  try {
    return JSON.parse(fss.readFileSync(f, 'utf8')).sessionId as string;
  } catch {
    const id = `splat-${projectId}-${crypto.randomUUID().slice(0, 8)}`;
    fss.writeFileSync(f, JSON.stringify({ sessionId: id }));
    return id;
  }
}

export function resetHermesSession(projectId: string) {
  fss.rmSync(path.join(stateDir(projectId), 'hermes-session.json'), { force: true });
}

/** Stream one completion. Calls onText with the full raw text so far and onTool for Hermes's own tool activity. */
async function complete(
  messages: OpenAIMessage[],
  sid: string,
  signal: AbortSignal,
  on: { text: (raw: string) => void; thinking: (t: string) => void; tool: (name: string, preview: string) => void },
) {
  const { url, model } = hermesConfig();
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: headers(sid),
    body: JSON.stringify({ model: model || 'hermes-agent', messages, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`Hermes answered ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 400)}` : ''}`);
  }
  let raw = '';
  let thinking = '';
  let event = '';
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line) {
        event = '';
        continue;
      }
      if (line.startsWith(':')) continue; // keepalive comment
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return raw;
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (event === 'hermes.tool.progress') {
        const name = String(j.tool ?? j.name ?? j.tool_name ?? 'tool');
        const preview = String(j.preview ?? j.message ?? j.label ?? j.args ?? '').slice(0, 300);
        on.tool(name, preview);
        continue;
      }
      if (j.error) throw new Error(`Hermes: ${typeof j.error === 'string' ? j.error : (j.error.message ?? JSON.stringify(j.error))}`);
      const d = j.choices?.[0]?.delta ?? {};
      if (d.reasoning_content) {
        thinking += d.reasoning_content;
        on.thinking(thinking);
      }
      if (d.content) {
        raw += d.content;
        on.text(raw);
      }
    }
  }
  return raw;
}

/**
 * Run one user turn against Hermes, filling m.blocks as it streams.
 * Returns when the reply is applied and rendered (or the fix rounds run out).
 */
export async function runHermesTurn(opts: {
  projectId: string;
  history: Msg[];
  text: string;
  imageIds: string[];
  m: Msg;
  signal: AbortSignal;
  emit: () => void;
}) {
  const { projectId, history, text, imageIds, m, signal, emit } = opts;
  const blocks = m.blocks!;
  const sid = sessionId(projectId);
  const parts = (await Promise.all(imageIds.map((id) => imagePart(projectId, id)))).filter((p) => !!p);
  const userContent: OpenAIContent = parts.length ? [{ type: 'text', text: text || '(see attached image)' }, ...parts] : text;
  const convo: OpenAIMessage[] = [...historyMessages(history), { role: 'user', content: userContent }];

  for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
    const textBlock: Block = { type: 'text', text: '' };
    let thinkingBlock: Block | null = null;
    let textPlaced = false;
    const raw = await complete([{ role: 'system', content: await systemPrompt(projectId) }, ...convo], sid, signal, {
      text: (r) => {
        if (!textPlaced) {
          blocks.push(textBlock);
          textPlaced = true;
        }
        (textBlock as { text: string }).text = visibleText(r);
        emit();
      },
      thinking: (t) => {
        if (!thinkingBlock) {
          thinkingBlock = { type: 'thinking', text: '' };
          blocks.push(thinkingBlock);
        }
        (thinkingBlock as { text: string }).text = t;
        emit();
      },
      tool: (name, preview) => {
        blocks.push({ type: 'tool', id: crypto.randomUUID(), name: `hermes:${name}`, input: { preview }, result: preview || 'done' });
        emit();
      },
    });

    const files = fileBlocks(raw);
    if (!files.length) break;
    for (const f of files) {
      const b: ToolBlock = { type: 'tool', id: crypto.randomUUID(), name: 'splat_write', input: { path: f.path, content: f.content } };
      blocks.push(b);
      try {
        if (f.path === 'project.json') throw new Error('project.json is managed by Splat');
        const dest = safePath(projectId, f.path);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, f.content);
        b.result = `${f.content.split('\n').length} lines`;
      } catch (err) {
        b.result = String((err as Error).message ?? err);
        b.isError = true;
      }
      emit();
    }
    const rb: ToolBlock = { type: 'tool', id: crypto.randomUUID(), name: 'splat_render', input: {} };
    blocks.push(rb);
    emit();
    const r = await renderReport(projectId);
    rb.result = r.text;
    rb.isError = r.isError;
    emit();
    if (!r.isError || round === MAX_FIX_ROUNDS || signal.aborted) break;
    convo.push(
      { role: 'assistant', content: raw },
      { role: 'user', content: `Splat rendered your files and the render failed:\n${r.text}\n\nFix the problem and send the corrected file(s) in full.` },
    );
  }
}

/** Check the gateway is reachable and the key is accepted. */
export async function testHermes(): Promise<{ ok: boolean; message: string; model?: string }> {
  const { url } = hermesConfig();
  if (!url) return { ok: false, message: 'No Hermes URL configured.' };
  try {
    const res = await fetch(`${url}/v1/models`, { headers: headers(), signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403) return { ok: false, message: `Hermes rejected the API key (${res.status}). Check API_SERVER_KEY.` };
    if (!res.ok) return { ok: false, message: `Hermes answered ${res.status} ${res.statusText}.` };
    const j = (await res.json().catch(() => ({}))) as { data?: { id: string }[] };
    return { ok: true, message: 'Connected to Hermes.', model: j.data?.[0]?.id };
  } catch (err) {
    return { ok: false, message: `Couldn't reach Hermes at ${url}: ${String((err as Error).message ?? err)}` };
  }
}
