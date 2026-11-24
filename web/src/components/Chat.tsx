import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, fileToBase64, P, type Block, type ChatMessage } from '../api';

interface Props {
  projectId: string;
  messages: ChatMessage[];
  running: boolean;
  claudeReady: boolean;
  onOpenSettings: () => void;
  captureView: () => string | null;
  draft: string;
  setDraft: (s: string) => void;
}

interface PendingImage {
  mediaType: string;
  data: string;
  preview: string;
}

const SUGGESTIONS = [
  'A wall-mount bracket for a 25 mm pipe with two M4 screw holes',
  'An enclosure for a Raspberry Pi 4 with vents and a snap-fit lid',
  'A parametric cable clip for 6 mm cables that sticks under a desk',
  'A hex-bit holder for 12 bits with labels on the front',
];

function toolLabel(b: Extract<Block, { type: 'tool' }>): string {
  const i = b.input ?? {};
  const file = (p?: string) => (p ? String(p).split('/').slice(-2).join('/') : '');
  switch (b.name) {
    case 'mcp__splat__render':
      return b.result === undefined ? 'Rendering…' : b.isError ? 'Render failed' : 'Rendered';
    case 'mcp__splat__snapshot':
      return `Looked at the model${b.images ? ` (${b.images} views)` : ''}`;
    case 'Write':
      return `Wrote ${file(i.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${file(i.file_path)}`;
    case 'Read':
      return `Read ${file(i.file_path)}`;
    case 'Bash':
      return `Ran ${String(i.description || i.command || '').slice(0, 60)}`;
    case 'Glob':
    case 'Grep':
      return `Searched ${String(i.pattern ?? '').slice(0, 40)}`;
    case 'WebSearch':
      return `Searched the web: ${String(i.query ?? '').slice(0, 50)}`;
    case 'WebFetch':
      return `Read ${String(i.url ?? '').slice(0, 50)}`;
    case 'TodoWrite':
      return 'Updated plan';
    case 'Task':
    case 'Agent':
      return `Delegated: ${String(i.description ?? '').slice(0, 50)}`;
    default:
      return b.name.replace(/^mcp__\w+__/, '');
  }
}

function ToolChip({ b }: { b: Extract<Block, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const pending = b.result === undefined;
  const detail =
    b.name === 'Edit' && b.input?.old_string !== undefined
      ? `--- ${b.input.file_path}\n- ${String(b.input.old_string).split('\n').join('\n- ')}\n+ ${String(b.input.new_string).split('\n').join('\n+ ')}`
      : b.name === 'Write'
        ? String(b.input?.content ?? '')
        : b.name === 'Bash'
          ? `$ ${b.input?.command ?? ''}`
          : JSON.stringify(b.input, null, 2);
  return (
    <div className={`tool ${b.isError ? 'err' : ''} ${pending ? 'pending' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-dot" />
        {toolLabel(b)}
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-body">
          {detail && detail !== '{}' && <pre>{detail.slice(0, 6000)}</pre>}
          {b.result && <pre className="result">{b.result}</pre>}
        </div>
      )}
    </div>
  );
}

function Message({ m, projectId }: { m: ChatMessage; projectId: string }) {
  if (m.role === 'user')
    return (
      <div className="msg user">
        {m.images?.map((img) => <img key={img} src={`${P(projectId)}/chat/upload/${img}`} alt="attachment" />)}
        {m.text && <div className="bubble">{m.text}</div>}
      </div>
    );
  const blocks = m.blocks ?? [];
  const working = !m.done;
  return (
    <div className="msg assistant">
      {blocks.map((b, i) => {
        if (b.type === 'text') return b.text.trim() ? <div key={i} className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{b.text}</ReactMarkdown></div> : null;
        if (b.type === 'thinking') return working && i === blocks.length - 1 ? <div key={i} className="thinking">Thinking…</div> : null;
        if (b.name === 'TodoWrite' || b.name === 'ToolSearch') return null;
        return <ToolChip key={b.id || i} b={b} />;
      })}
      {working && blocks.length === 0 && <div className="thinking">Claude is starting…</div>}
      {working && blocks.length > 0 && <div className="typing"><span /><span /><span /></div>}
      {m.error && <div className="msg-error">{m.error}</div>}
      {m.done && (m.commit || m.costUsd) ? (
        <div className="msg-meta">
          {m.commit && <span>Saved as version {m.commit.slice(0, 7)}</span>}
          {m.durationMs ? <span>{Math.round(m.durationMs / 1000)}s</span> : null}
          {m.costUsd ? <span>${m.costUsd.toFixed(3)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Chat({ projectId, messages, running, claudeReady, onOpenSettings, captureView, draft, setDraft }: Props) {
  const [images, setImages] = useState<PendingImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  const addImage = async (file: Blob) => {
    const data = await fileToBase64(file);
    setImages((imgs) => [...imgs, { mediaType: file.type || 'image/png', data, preview: URL.createObjectURL(file) }]);
  };

  const attachView = () => {
    const url = captureView();
    if (!url) return;
    setImages((imgs) => [...imgs, { mediaType: 'image/png', data: url.replace(/^data:image\/png;base64,/, ''), preview: url }]);
  };

  const send = async (text = draft) => {
    if (!text.trim() && !images.length) return;
    setError(null);
    setSending(true);
    try {
      await api(`${P(projectId)}/chat`, { json: { text: text.trim(), images: images.map(({ mediaType, data }) => ({ mediaType, data })) } });
      setDraft('');
      setImages([]);
      stick.current = true;
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!running) void send();
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) {
          e.preventDefault();
          void addImage(f);
        }
      }
    }
  };

  const newChat = async () => {
    if (!confirm('Start a new conversation? Your model and history stay; Claude just forgets this chat.')) return;
    await api(`${P(projectId)}/chat/reset`, { method: 'POST' });
  };

  return (
    <div className="chat">
      <div className="chat-head">
        <span>Chat</span>
        <button className="ghost small" onClick={newChat} title="Start a fresh conversation">New chat</button>
      </div>
      <div
        className="chat-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {!claudeReady && (
          <div className="notice">
            Claude isn't connected yet. <button className="link" onClick={onOpenSettings}>Open Settings</button> to add an API key or your
            Claude subscription token.
          </div>
        )}
        {messages.length === 0 && (
          <div className="empty-chat">
            <p>Describe what you want to make. Claude writes the OpenSCAD, renders it and checks the result. You'll see it appear on the right.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => setDraft(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => <Message key={m.id} m={m} projectId={projectId} />)}
      </div>
      {error && <div className="chat-error">{error}</div>}
      {images.length > 0 && (
        <div className="pending-images">
          {images.map((img, i) => (
            <div key={i} className="pending-image">
              <img src={img.preview} alt="" />
              <button onClick={() => setImages(images.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
      )}
      <div className="composer">
        <textarea
          ref={input}
          value={draft}
          placeholder={running ? 'Claude is working… you can type your next message' : 'Ask for a part or a change… (Enter to send)'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          rows={1}
        />
        <div className="composer-actions">
          <button className="ghost small" onClick={attachView} title="Attach a picture of the current 3D view">📷 View</button>
          <button className="ghost small" onClick={() => fileInput.current?.click()} title="Attach an image (sketch, photo, drawing)">🖼 Image</button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            multiple
            onChange={(e) => {
              for (const f of e.target.files ?? []) void addImage(f);
              e.target.value = '';
            }}
          />
          <span className="spacer" />
          {running ? (
            <button className="danger small" onClick={() => api(`${P(projectId)}/chat/stop`, { method: 'POST' })}>Stop</button>
          ) : (
            <button className="primary small" disabled={sending || (!draft.trim() && !images.length)} onClick={() => void send()}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
