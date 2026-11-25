import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { query, tool, createSdkMcpServer, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { projectDir, readMeta, stateDir, touch } from './projects.js';
import { preview } from './preview.js';
import { capabilities, snapshots, VIEWS } from './openscad.js';
import { broadcast } from './hub.js';
import { agentKind, claudeAuth, getSettings } from './settings.js';
import { commitAll } from './git.js';
import { OPENSCAD_PATH } from './config.js';
import { renderReport } from './render-report.js';
import { hermesReady, resetHermesSession, runHermesTurn, testHermes } from './hermes.js';

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown; inputJson?: string; result?: string; isError?: boolean; images?: number };

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
  /** Which agent wrote this reply. */
  agent?: 'claude' | 'hermes';
}

export interface ImageInput {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string; // base64
}

const MAX_RESULT_CHARS = 4000;

function systemAppend(meta: { name: string; main: string }, caps: Awaited<ReturnType<typeof capabilities>>) {
  const s = getSettings();
  return `
# Splat
You are the modeling assistant inside Splat, a self-hosted web app where the user designs 3D-printable parts in OpenSCAD by chatting with you.
The user sees a live 3D preview next to this chat. It renders the project's main file (\`${meta.main}\`, set by "main" in project.json) and re-renders automatically every time a file in the project changes. They can also edit code by hand, tweak customizer parameters, browse version history and export (3MF/STL/STEP/OBJ/...).

Project: "${meta.name}". Your working directory is the project folder. Layout:
- \`${meta.main}\`: the model the preview shows. Other .scad files can be used/included from it.
- \`assets/\`: files the user imported (STL/3MF/OBJ/SVG/DXF; STEP and OBJ imports are converted to a sibling .stl you can import()).
- \`project.json\`: name and main file. Leave \`.git\` and \`.splat\` alone: the app commits a version after each of your turns, so never run git commit yourself.

Tools:
- \`mcp__splat__render\` renders the main file exactly as the preview does and returns errors, warnings, ECHO output, bounding box, volume and triangle count. Call it after every change and fix any error before you finish.
- \`mcp__splat__snapshot\` returns PNG pictures of the rendered model from chosen angles (${Object.keys(VIEWS).join(', ')}). Use it to check the shape visually when geometry matters (fit, orientation, booleans that might have failed).
- OpenSCAD is \`${caps.bin}\` (version ${caps.version}${caps.manifold ? ', Manifold backend enabled so renders are fast' : ''}) if you need it in Bash. Libraries on OPENSCADPATH (${OPENSCAD_PATH}): BOSL2 (\`include <BOSL2/std.scad>\`, plus threading.scad, screws.scad, gears.scad, hinges.scad...), and anything the user placed in their libraries folder. Python 3 with trimesh is available for mesh inspection.

How to work:
- Units are millimetres, Z is up, the part should sit on Z=0 in its best print orientation unless the user says otherwise.
- Write clean parametric code: key dimensions as top-level variables before any module, annotated for the customizer, e.g. \`wall = 2; // [0.8:0.2:5] Wall thickness\`, grouped with \`/* [Group name] */\` and \`/* [Hidden] */\` for internals. The user tweaks these in a Parameters panel.
- Mostly functional parts and enclosures: think about FDM printability (avoid unsupported overhangs past ~45°, sensible wall thickness ≥1.2 mm, clearance 0.2–0.3 mm for fits, chamfer bottom edges rather than fillet them, real-world screw/insert sizes like M3 heat-set inserts).
- Use $fn/$fa/$fs so curves are smooth in exports but renders stay quick (e.g. \`$fa = 2; $fs = 0.4;\`).
- When the user refers to an imported file, look in assets/ and use import().
- Keep chat replies short: say what you built or changed and the key dimensions. The user is looking at the model, not reading code.
${s.printerProfile ? `\nUser's printer / slicer setup:\n${s.printerProfile}\n` : ''}${s.customInstructions ? `\nUser's standing instructions:\n${s.customInstructions}\n` : ''}`;
}

function clip(s: string, n = MAX_RESULT_CHARS) {
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s;
}

function splatTools(projectId: string) {
  return createSdkMcpServer({
    name: 'splat',
    version: '1.0.0',
    tools: [
      tool(
        'render',
        'Render the project main file the same way the live preview does. Returns status, errors, warnings, echo output and mesh statistics (bounding box in mm, volume, triangles).',
        {},
        async () => {
          const r = await renderReport(projectId);
          return { content: [{ type: 'text', text: r.text }], isError: r.isError };
        },
      ),
      tool(
        'snapshot',
        'Render pictures of the current model (as last rendered) from one or more camera angles so you can see it. Call render first if you changed files.',
        {
          views: z
            .array(z.enum(Object.keys(VIEWS) as [string, ...string[]]))
            .optional()
            .describe('Camera angles. Default: iso, front, top, right.'),
        },
        async ({ views }) => {
          const p = preview(projectId);
          if (p.state.status === 'rendering') await p.next();
          if (!p.state.file || p.state.status !== 'ok')
            return { content: [{ type: 'text', text: 'No successful render to show. Fix render errors first.' }], isError: true };
          const file = path.join(stateDir(projectId), p.state.file);
          const shots = await snapshots(file, views?.length ? views : ['iso', 'front', 'top', 'right'], 560);
          return {
            content: shots.flatMap((s) => [
              { type: 'text' as const, text: `${s.view} view:` },
              { type: 'image' as const, data: s.png.toString('base64'), mimeType: 'image/png' },
            ]),
          };
        },
      ),
    ],
  });
}

class ChatSession {
  messages: ChatMessage[] = [];
  running = false;
  private abort: AbortController | null = null;
  private current: ChatMessage | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private loaded = false;

  constructor(public projectId: string) {}

  private get file() {
    return path.join(stateDir(this.projectId), 'chat.jsonl');
  }
  private get sessionFile() {
    return path.join(stateDir(this.projectId), 'session.json');
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.messages = raw
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as ChatMessage);
    } catch {
      this.messages = [];
    }
  }

  private async append(m: ChatMessage) {
    await fs.appendFile(this.file, JSON.stringify(m) + '\n');
  }

  private sessionId(): string | undefined {
    try {
      return JSON.parse(fss.readFileSync(this.sessionFile, 'utf8')).sessionId;
    } catch {
      return undefined;
    }
  }

  private emit(m: ChatMessage, immediate = false) {
    if (immediate) {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = null;
      broadcast(this.projectId, { type: 'chat-message', message: m });
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      broadcast(this.projectId, { type: 'chat-message', message: m });
    }, 80);
  }

  async reset() {
    if (this.running) this.stop();
    await this.load();
    if (fss.existsSync(this.file)) await fs.rename(this.file, path.join(stateDir(this.projectId), `chat-${Date.now()}.jsonl`));
    await fs.rm(this.sessionFile, { force: true });
    resetHermesSession(this.projectId);
    this.messages = [];
    broadcast(this.projectId, { type: 'chat-reset' });
  }

  stop() {
    this.abort?.abort();
  }

  async send(text: string, images: ImageInput[] = []) {
    await this.load();
    const agent = agentKind();
    if (this.running) throw new Error(`${agent === 'hermes' ? 'Hermes' : 'Claude'} is still working on the last message`);
    if (agent === 'hermes') {
      if (!hermesReady()) throw new Error('Hermes is selected but not connected yet. Add the Hermes URL and API key in Settings.');
    } else if (claudeAuth().mode === 'none') throw new Error('Claude is not connected yet. Add an API key or a Claude subscription token in Settings.');

    // Keep hand edits made since the last version separate from what Claude changes.
    await commitAll(projectDir(this.projectId), 'Manual edits').catch(() => null);

    const imageIds: string[] = [];
    for (const img of images) {
      const id = crypto.randomUUID();
      const ext = img.mediaType.split('/')[1];
      await fs.mkdir(path.join(stateDir(this.projectId), 'uploads'), { recursive: true });
      await fs.writeFile(path.join(stateDir(this.projectId), 'uploads', `${id}.${ext}`), Buffer.from(img.data, 'base64'));
      imageIds.push(`${id}.${ext}`);
    }
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', ts: new Date().toISOString(), text, images: imageIds };
    this.messages.push(userMsg);
    await this.append(userMsg);
    this.emit(userMsg, true);

    const history = this.messages.slice(0, -1);
    const assistant: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', ts: new Date().toISOString(), blocks: [], done: false, agent };
    this.current = assistant;
    this.running = true;
    broadcast(this.projectId, { type: 'chat-status', running: true });
    this.emit(assistant, true);
    const turn = agent === 'hermes' ? this.runHermes(text, imageIds, history, assistant) : this.runTurn(text, images, assistant);
    void turn.finally(() => {
      this.running = false;
      this.current = null;
      broadcast(this.projectId, { type: 'chat-status', running: false });
    });
    return userMsg;
  }

  snapshot() {
    return { messages: this.current ? [...this.messages, this.current] : this.messages, running: this.running };
  }

  private async runTurn(text: string, images: ImageInput[], m: ChatMessage) {
    const started = Date.now();
    const meta = await readMeta(this.projectId);
    const caps = await capabilities();
    const auth = claudeAuth();
    const settings = getSettings();
    this.abort = new AbortController();

    const env: Record<string, string | undefined> = { ...process.env, OPENSCADPATH: OPENSCAD_PATH, ...auth.env };
    if (auth.mode === 'oauth-token') delete env.ANTHROPIC_API_KEY;
    if (auth.mode === 'api-key') delete env.CLAUDE_CODE_OAUTH_TOKEN;
    if (process.getuid?.() === 0) env.IS_SANDBOX = '1';
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? '1';

    const content: SDKUserMessage['message']['content'] = [
      ...images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.data } })),
      { type: 'text' as const, text: text || '(see attached image)' },
    ];
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, origin: { kind: 'human' } } as SDKUserMessage;
    }

    const toolById = new Map<string, Extract<Block, { type: 'tool' }>>();
    let streamingBlock: Block | null = null;
    let sawStreamText = false;
    const resume = this.sessionId();

    const run = async (resumeId?: string) => {
      const q = query({
        prompt: prompt(),
        options: {
          cwd: projectDir(this.projectId),
          resume: resumeId,
          model: settings.model || process.env.CLAUDE_MODEL || undefined,
          abortController: this.abort!,
          includePartialMessages: true,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          disallowedTools: ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'],
          settingSources: ['user', 'project'],
          systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend(meta, caps) },
          mcpServers: { splat: splatTools(this.projectId) },
          env,
          stderr: (d) => process.stderr.write(`[claude ${this.projectId}] ${d}`),
        },
      });
      for await (const msg of q as AsyncIterable<SDKMessage>) this.handle(msg, m, toolById, {
        get block() { return streamingBlock; },
        set block(b) { streamingBlock = b; },
        get sawText() { return sawStreamText; },
        set sawText(v) { sawStreamText = v; },
      });
    };

    try {
      try {
        await run(resume);
      } catch (err) {
        // A stale session id (e.g. Claude data wiped) should not brick the chat: retry fresh once.
        if (resume && !this.abort.signal.aborted && /session|conversation/i.test(String(err)) && !m.blocks!.length) {
          await fs.rm(this.sessionFile, { force: true });
          await run(undefined);
        } else throw err;
      }
    } catch (err) {
      if (this.abort.signal.aborted) m.error = 'Stopped.';
      else m.error = friendlyError(String((err as Error)?.message ?? err));
    }
    await this.finish(text, m, started, 'Claude');
  }

  private async runHermes(text: string, imageIds: string[], history: ChatMessage[], m: ChatMessage) {
    const started = Date.now();
    this.abort = new AbortController();
    try {
      await runHermesTurn({ projectId: this.projectId, history, text, imageIds, m, signal: this.abort.signal, emit: () => this.emit(m) });
    } catch (err) {
      if (this.abort.signal.aborted) m.error = 'Stopped.';
      else m.error = String((err as Error)?.message ?? err);
    }
    await this.finish(text, m, started, 'Hermes');
  }

  private async finish(text: string, m: ChatMessage, started: number, who: string) {
    m.done = true;
    m.durationMs = Date.now() - started;
    const firstLine = text.split('\n')[0].trim();
    try {
      m.commit = await commitAll(projectDir(this.projectId), `${who}: ${firstLine.slice(0, 72) || 'update'}${firstLine.length > 72 ? '…' : ''}`);
      if (m.commit) {
        await touch(this.projectId);
        await commitAll(projectDir(this.projectId), 'Update project metadata').catch(() => null);
        broadcast(this.projectId, { type: 'history-changed' });
      }
    } catch (err) {
      console.error('commit failed', err);
    }
    this.messages.push(m);
    await this.append(m);
    this.emit(m, true);
  }

  private handle(
    msg: SDKMessage,
    m: ChatMessage,
    toolById: Map<string, Extract<Block, { type: 'tool' }>>,
    st: { block: Block | null; sawText: boolean },
  ) {
    const blocks = m.blocks!;
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && msg.session_id) {
          fss.writeFileSync(this.sessionFile, JSON.stringify({ sessionId: msg.session_id }));
        }
        break;
      case 'stream_event': {
        if (msg.parent_tool_use_id) break; // subagent chatter
        const ev = msg.event;
        if (ev.type === 'content_block_start') {
          const cb = ev.content_block;
          if (cb.type === 'text') {
            st.block = { type: 'text', text: cb.text ?? '' };
            blocks.push(st.block);
            st.sawText = true;
          } else if (cb.type === 'thinking') {
            st.block = { type: 'thinking', text: '' };
            blocks.push(st.block);
          } else if (cb.type === 'tool_use' || cb.type === 'server_tool_use' || cb.type === 'mcp_tool_use') {
            const t: Extract<Block, { type: 'tool' }> = { type: 'tool', id: cb.id, name: cb.name, input: {}, inputJson: '' };
            toolById.set(cb.id, t);
            blocks.push(t);
            st.block = t;
          } else st.block = null;
        } else if (ev.type === 'content_block_delta' && st.block) {
          const d = ev.delta;
          if (d.type === 'text_delta' && st.block.type === 'text') st.block.text += d.text;
          else if (d.type === 'thinking_delta' && st.block.type === 'thinking') st.block.text += d.thinking;
          else if (d.type === 'input_json_delta' && st.block.type === 'tool') {
            st.block.inputJson = (st.block.inputJson ?? '') + d.partial_json;
            try {
              st.block.input = JSON.parse(st.block.inputJson);
            } catch {
              /* partial */
            }
          }
        } else if (ev.type === 'content_block_stop') st.block = null;
        this.emit(m);
        break;
      }
      case 'assistant': {
        if (msg.parent_tool_use_id) break;
        for (const cb of msg.message.content) {
          if (cb.type === 'tool_use' || cb.type === 'server_tool_use' || cb.type === 'mcp_tool_use') {
            const existing = toolById.get(cb.id);
            if (existing) {
              existing.input = cb.input;
              delete existing.inputJson;
            } else {
              const t: Extract<Block, { type: 'tool' }> = { type: 'tool', id: cb.id, name: cb.name, input: cb.input };
              toolById.set(cb.id, t);
              blocks.push(t);
            }
          } else if (cb.type === 'text' && !st.sawText) {
            blocks.push({ type: 'text', text: cb.text });
          }
        }
        st.sawText = false;
        if (msg.error) m.error = friendlyError(String(msg.error));
        this.emit(m);
        break;
      }
      case 'user': {
        if (msg.parent_tool_use_id) break;
        const c = msg.message.content;
        if (!Array.isArray(c)) break;
        for (const part of c) {
          if (part.type !== 'tool_result') continue;
          const t = toolById.get(part.tool_use_id);
          if (!t) continue;
          let images = 0;
          const textOut =
            typeof part.content === 'string'
              ? part.content
              : (part.content ?? [])
                  .map((x) => {
                    if (x.type === 'text') return x.text;
                    if (x.type === 'image') images++;
                    return '';
                  })
                  .filter(Boolean)
                  .join('\n');
          t.result = clip(textOut);
          t.isError = !!part.is_error;
          if (images) t.images = images;
        }
        this.emit(m);
        break;
      }
      case 'result': {
        m.costUsd = msg.total_cost_usd;
        if (msg.subtype !== 'success') m.error = friendlyError(('errors' in msg && msg.errors?.join('\n')) || msg.subtype);
        else if (msg.is_error) m.error = friendlyError(msg.result);
        if (msg.session_id) fss.writeFileSync(this.sessionFile, JSON.stringify({ sessionId: msg.session_id }));
        break;
      }
      default:
        break;
    }
  }
}

function friendlyError(e: string) {
  if (/invalid api key|authentication|401|OAuth token|not logged in|login/i.test(e))
    return `Claude couldn't sign in: ${e}\nCheck the API key or subscription token in Settings.`;
  if (/rate.?limit|429|usage limit/i.test(e)) return `Claude hit a rate or usage limit: ${e}`;
  return e;
}

const sessions = new Map<string, ChatSession>();
export function chat(projectId: string) {
  let s = sessions.get(projectId);
  if (!s) {
    s = new ChatSession(projectId);
    sessions.set(projectId, s);
  }
  return s;
}

/** Test whichever agent is selected (or the one asked for). */
export function testAgent(which?: 'claude' | 'hermes') {
  return (which ?? agentKind()) === 'hermes' ? testHermes() : testClaude();
}

/** Quick check that the configured credentials work, by asking Claude Code for a one-word reply. */
export async function testClaude(): Promise<{ ok: boolean; message: string; model?: string }> {
  const auth = claudeAuth();
  if (auth.mode === 'none') return { ok: false, message: 'No credentials configured.' };
  const env: Record<string, string | undefined> = { ...process.env, ...auth.env };
  if (auth.mode === 'oauth-token') delete env.ANTHROPIC_API_KEY;
  if (auth.mode === 'api-key') delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (process.getuid?.() === 0) env.IS_SANDBOX = '1';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 90_000);
  let model: string | undefined;
  try {
    for await (const msg of query({
      prompt: 'Reply with the single word: ready',
      options: {
        abortController: ac,
        maxTurns: 1,
        tools: [],
        settingSources: [],
        persistSession: false,
        model: getSettings().model || process.env.CLAUDE_MODEL || undefined,
        env,
      },
    })) {
      if (msg.type === 'system' && msg.subtype === 'init') model = msg.model;
      if (msg.type === 'result') {
        if (msg.subtype === 'success' && !msg.is_error) return { ok: true, message: `Connected (${auth.mode === 'api-key' ? 'API key' : 'subscription token'}).`, model };
        return { ok: false, message: friendlyError(msg.subtype === 'success' ? msg.result : msg.subtype), model };
      }
    }
    return { ok: false, message: 'No response from Claude Code.' };
  } catch (err) {
    return { ok: false, message: friendlyError(String((err as Error)?.message ?? err)) };
  } finally {
    clearTimeout(timer);
  }
}
