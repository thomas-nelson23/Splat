import { useCallback, useEffect, useRef, useState } from 'react';
import { agentName, api, P, type ChatMessage, type PreviewState, type ProjectMeta, type Status } from '../api';
import { useProjectSocket } from '../useSocket';
import { Viewer, type ViewerHandle } from './Viewer';
import { Chat } from './Chat';
import { CodeEditor } from './CodeEditor';
import { ParamsPanel } from './ParamsPanel';
import { FilesPanel, uploadFiles } from './FilesPanel';
import { HistoryPanel } from './HistoryPanel';
import { ExportPanel } from './ExportPanel';
import { Back, Gear, HexMark } from './Glyphs';

type Tab = 'code' | 'params' | 'files' | 'history' | 'export';
type MobileTab = 'chat' | 'model' | 'panel';

interface Props {
  projectId: string;
  status: Status | null;
  firstMessage?: string;
  onBack: () => void;
  onSettings: () => void;
}

export function Workspace({ projectId, status, firstMessage, onBack, onSettings }: Props) {
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [pv, setPv] = useState<PreviewState>({ status: 'idle', version: 0 });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<Tab>('params');
  const [mobileTab, setMobileTab] = useState<MobileTab>('chat');
  const [filesKey, setFilesKey] = useState(0);
  const [historyKey, setHistoryKey] = useState(0);
  const [paramsKey, setParamsKey] = useState(0);
  const [viewingSha, setViewingSha] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [hasOverrides, setHasOverrides] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [scadFiles, setScadFiles] = useState<string[]>([]);

  // code editor state
  const [file, setFile] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [docVersion, setDocVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const saveTimer = useRef<number | undefined>(undefined);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const fileRef = useRef<string | null>(null);
  fileRef.current = file;

  const viewer = useRef<ViewerHandle>(null);
  const sentFirst = useRef(false);
  const lastThumb = useRef(0);

  const loadMeta = useCallback(() => api<ProjectMeta>(P(projectId)).then((m) => {
    setMeta(m);
    return m;
  }), [projectId]);

  const loadFile = useCallback(async (path: string) => {
    const res = await fetch(`${P(projectId)}/file?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    const text = res.ok ? await res.text() : '';
    setFile(path);
    setCode(text);
    setDirty(false);
    setSaveState('saved');
    setDocVersion((v) => v + 1);
  }, [projectId]);

  const refreshAll = useCallback(async () => {
    const m = await loadMeta();
    setPv(await api<PreviewState>(`${P(projectId)}/preview`));
    const c = await api<{ messages: ChatMessage[]; running: boolean }>(`${P(projectId)}/chat`);
    setMessages(c.messages);
    setRunning(c.running);
    const params = await api<{ overrides: Record<string, unknown> }>(`${P(projectId)}/params`);
    setHasOverrides(Object.keys(params.overrides).length > 0);
    if (!fileRef.current) await loadFile(m.main);
    setFilesKey((k) => k + 1);
    setHistoryKey((k) => k + 1);
  }, [projectId, loadMeta, loadFile]);

  useEffect(() => {
    setFile(null);
    setMessages([]);
    setViewingSha(null);
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    void api<{ path: string }[]>(`${P(projectId)}/files`).then((fs) => setScadFiles(fs.map((f) => f.path).filter((p) => /\.(scad|json|csv|dat)$/.test(p))));
  }, [projectId, filesKey]);

  useEffect(() => {
    const h = () => void loadMeta().then((m) => loadFile(m.main));
    window.addEventListener('splat:project-changed', h);
    return () => window.removeEventListener('splat:project-changed', h);
  }, [loadMeta, loadFile]);

  // Kick off the first message when coming from "What do you want to make?"
  useEffect(() => {
    if (!firstMessage || sentFirst.current) return;
    sentFirst.current = true;
    void api(`${P(projectId)}/chat`, { json: { text: firstMessage, images: [] } }).catch(() => setDraft(firstMessage));
  }, [firstMessage, projectId]);

  useProjectSocket(
    projectId,
    (msg) => {
      switch (msg.type) {
        case 'render':
          setPv(msg.state);
          break;
        case 'chat-message':
          setMessages((ms) => {
            const i = ms.findIndex((m) => m.id === msg.message.id);
            if (i === -1) return [...ms, msg.message];
            const next = ms.slice();
            next[i] = msg.message;
            return next;
          });
          break;
        case 'chat-status':
          setRunning(msg.running);
          break;
        case 'chat-reset':
          setMessages([]);
          break;
        case 'files-changed': {
          setFilesKey((k) => k + 1);
          const p = String(msg.path ?? '');
          if (p === fileRef.current && !dirtyRef.current) void loadFile(p);
          if (p.endsWith('.scad')) setParamsKey((k) => k + 1);
          if (p === 'project.json') void loadMeta();
          break;
        }
        case 'history-changed':
          setHistoryKey((k) => k + 1);
          break;
      }
    },
    () => void refreshAll(),
  );

  // ---------------------------------------------------------------- code editing
  const save = useCallback(async (commit: boolean, content = code) => {
    if (!fileRef.current) return;
    clearTimeout(saveTimer.current);
    setSaveState('saving');
    await api(`${P(projectId)}/file?path=${encodeURIComponent(fileRef.current)}&commit=${commit ? 1 : 0}`, {
      method: 'PUT',
      body: content,
      headers: { 'Content-Type': 'text/plain' },
    });
    setDirty(false);
    setSaveState('saved');
  }, [projectId, code]);

  const onCodeChange = (v: string) => {
    setCode(v);
    setDirty(true);
    setSaveState('unsaved');
    clearTimeout(saveTimer.current);
    // Autosave shortly after typing stops so the preview follows along; Ctrl+S also saves a version.
    saveTimer.current = window.setTimeout(() => void save(false, v), 900);
  };

  // ---------------------------------------------------------------- viewer
  const modelUrl = viewingSha
    ? `${P(projectId)}/history/${viewingSha}/model`
    : pv.file
      ? `${P(projectId)}/preview/model`
      : null;

  const onModelLoaded = () => {
    if (viewingSha || Date.now() - lastThumb.current < 15_000) return;
    lastThumb.current = Date.now();
    setTimeout(() => {
      const dataUrl = viewer.current?.screenshot(480);
      if (dataUrl) void api(`${P(projectId)}/thumbnail`, { method: 'PUT', json: { dataUrl } }).catch(() => null);
    }, 300);
  };

  const askAgent = (text: string) => {
    setDraft(text);
    setMobileTab('chat');
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!e.dataTransfer.files.length) return;
    const results = await uploadFiles(projectId, e.dataTransfer.files);
    setTab('files');
    setFilesKey((k) => k + 1);
    const ok = results.filter((r) => r.ok);
    if (ok.length) askAgent(`I imported ${ok.map((r) => r.file).join(', ')}. `);
    const bad = results.filter((r) => !r.ok);
    if (bad.length) alert(bad.map((r) => `${r.name}: ${r.error}`).join('\n'));
  };

  const agent = status?.agent ?? 'claude';
  const agentReady = status ? status.agentReady : true;
  const log = pv.log;
  const problems = (log?.errors.length ?? 0) + (log?.warnings.length ?? 0);

  const renameProject = async () => {
    if (!meta) return;
    const name = prompt('Rename project', meta.name);
    if (!name) return;
    setMeta(await api(P(projectId), { method: 'PATCH', json: { name } }));
  };

  return (
    <div
      className={`workspace m-${mobileTab}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <button className="ghost icon" onClick={onBack} title="All projects" aria-label="All projects"><Back /></button>
        <div className="brand-mini"><HexMark /></div>
        <button className="project-name" onClick={renameProject} title="Rename">{meta?.name ?? '…'}</button>
        <span className={`render-pill ${pv.status}`}>
          <span className={`led ${pv.status === 'rendering' ? 'on' : pv.status === 'error' ? 'bad' : ''}`} />
          {pv.status === 'rendering' ? 'Rendering…' : pv.status === 'error' ? 'Render error' : pv.status === 'ok' ? `Rendered ${pv.durationMs !== undefined ? `in ${(pv.durationMs / 1000).toFixed(1)}s` : ''}` : 'Idle'}
        </span>
        <span className="spacer" />
        <span className="agent-pill">{agentName(agent)}</span>
        <button className="ghost icon" onClick={onSettings} title="Settings" aria-label="Settings"><Gear /></button>
      </header>

      <div className="ws-body">
        <aside className="pane chat-pane">
          <Chat
            projectId={projectId}
            messages={messages}
            running={running}
            agent={agent}
            agentReady={agentReady}
            onOpenSettings={onSettings}
            captureView={() => viewer.current?.screenshot(1024) ?? null}
            draft={draft}
            setDraft={setDraft}
          />
        </aside>

        <main className="pane view-pane">
          <Viewer ref={viewer} url={modelUrl} kind={viewingSha ? undefined : pv.kind} version={viewingSha ?? pv.version} fitKey={projectId} onLoaded={onModelLoaded} />
          {viewingSha && (
            <div className="viewing-banner">
              <span className="led" />
              Previewing an older version · {viewingSha.slice(0, 7)}
              <button className="small" onClick={() => setViewingSha(null)}>Back to current</button>
            </div>
          )}
          {pv.status === 'rendering' && <div className="busy render-busy" title="Rendering" />}
          {pv.kind === 'empty' && !viewingSha && <div className="viewer-msg">The model is empty. Nothing to show yet.</div>}
          <div className={`statusbar ${pv.status === 'error' ? 'error' : ''}`}>
            {pv.stats && (
              <span title="Bounding box">
                {pv.stats.size.map((n) => n.toFixed(1)).join(' × ')} mm · {(pv.stats.volume / 1000).toFixed(1)} cm³ · {pv.stats.triangles.toLocaleString()} triangles
              </span>
            )}
            {pv.kind === '2d' && <span>2D design (shown 1 mm thick)</span>}
            <span className="spacer" />
            {(problems > 0 || (log?.echoes.length ?? 0) > 0 || pv.status === 'error') && (
              <button className="ghost small" onClick={() => setShowLog(!showLog)}>
                {log?.errors.length ? `${log.errors.length} error${log.errors.length > 1 ? 's' : ''}` : ''}
                {log?.warnings.length ? ` ${log.warnings.length} warning${log.warnings.length > 1 ? 's' : ''}` : ''}
                {!problems && pv.status !== 'error' ? 'Console' : ''}
                {!problems && pv.status === 'error' ? 'Error details' : ''}
              </button>
            )}
            {pv.status === 'error' && (
              <button
                className="small primary"
                onClick={() => askAgent(`The render fails with:\n${(log?.errors.join('\n') || log?.raw.split('\n').slice(-8).join('\n') || '').slice(0, 1500)}\nPlease fix it.`)}
              >
                Ask {agentName(agent)} to fix
              </button>
            )}
          </div>
          {showLog && log && (
            <pre className="console">
              {[...log.errors, ...log.warnings, ...log.echoes].join('\n') || log.raw}
            </pre>
          )}
          {dragging && <div className="drop-overlay">Drop to import into this project</div>}
        </main>

        <aside className="pane side-pane">
          <nav className="tabs">
            {(['params', 'code', 'files', 'history', 'export'] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {{ params: 'Parameters', code: 'Code', files: 'Files', history: 'History', export: 'Export' }[t]}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {tab === 'code' && file && (
              <div className="code-tab">
                <div className="code-head">
                  <select value={file} onChange={(e) => void loadFile(e.target.value)}>
                    {[...new Set([file, ...scadFiles])].map((f) => (
                      <option key={f} value={f}>{f}{f === meta?.main ? ' (main)' : ''}</option>
                    ))}
                  </select>
                  <span className="muted small">{saveState === 'saving' ? 'Saving…' : saveState === 'unsaved' ? 'Unsaved' : 'Saved'}</span>
                  <span className="spacer" />
                  <button className="ghost small" onClick={() => void save(true)} title="Save and record a version (Ctrl+S)">Save version</button>
                </div>
                <CodeEditor value={code} onChange={onCodeChange} onSave={() => void save(true)} docVersion={docVersion} />
              </div>
            )}
            {tab === 'params' && <ParamsPanel projectId={projectId} refreshKey={paramsKey} onOverrides={(n) => setHasOverrides(n > 0)} />}
            {tab === 'files' && meta && (
              <FilesPanel
                project={meta}
                refreshKey={filesKey}
                accept={(status?.importExtensions ?? []).map((e) => `.${e}`).join(',')}
                onOpen={(p) => {
                  void loadFile(p);
                  setTab('code');
                }}
                onAskClaude={askAgent}
              />
            )}
            {tab === 'history' && <HistoryPanel projectId={projectId} refreshKey={historyKey} viewing={viewingSha} onView={setViewingSha} />}
            {tab === 'export' && <ExportPanel projectId={projectId} formats={status?.exportFormats ?? []} kind={pv.kind} hasOverrides={hasOverrides} />}
          </div>
        </aside>
      </div>

      <nav className="mobile-tabs">
        {(['chat', 'model', 'panel'] as MobileTab[]).map((t) => (
          <button key={t} className={mobileTab === t ? 'on' : ''} onClick={() => setMobileTab(t)}>
            {{ chat: 'Chat', model: 'Model', panel: 'Tools' }[t]}
          </button>
        ))}
      </nav>
    </div>
  );
}
