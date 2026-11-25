import { useEffect, useState } from 'react';
import { api, type AgentKind, type PublicSettings, type Status } from '../api';
import { Close } from './Glyphs';

interface Props {
  status: Status | null;
  onClose: () => void;
  onSaved: () => void;
}

const MODELS = [
  { id: '', label: 'Claude Code default' },
  { id: 'opus', label: 'Opus (most capable)' },
  { id: 'sonnet', label: 'Sonnet (fast, capable)' },
  { id: 'haiku', label: 'Haiku (fastest, cheapest)' },
];

type TestResult = { ok: boolean; message: string; model?: string };

export function Settings({ status, onClose, onSaved }: Props) {
  const [s, setS] = useState<PublicSettings | null>(null);
  const [agent, setAgent] = useState<AgentKind>('claude');
  const [mode, setMode] = useState<'oauth-token' | 'api-key'>('oauth-token');
  const [secret, setSecret] = useState('');
  const [model, setModel] = useState('');
  const [hermesUrl, setHermesUrl] = useState('');
  const [hermesKey, setHermesKey] = useState('');
  const [hermesModel, setHermesModel] = useState('');
  const [printer, setPrinter] = useState('');
  const [instructions, setInstructions] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<PublicSettings>('/api/settings').then((r) => {
      setS(r);
      setAgent(r.agent);
      if (r.auth.mode !== 'none') setMode(r.auth.mode);
      setModel(r.model);
      setHermesUrl(r.hermesUrlSource === 'settings' ? r.hermesUrl : '');
      setHermesModel(r.hermesModel);
      setPrinter(r.printerProfile);
      setInstructions(r.customInstructions);
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const runTest = async (which = agent) => {
    setTest({ ok: true, message: 'Testing…' });
    setTest(await api<TestResult>('/api/settings/test', { json: { agent: which } }));
  };

  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, string> = { agent, model, printerProfile: printer, customInstructions: instructions, hermesUrl: hermesUrl.trim(), hermesModel: hermesModel.trim() };
      if (secret.trim()) body[mode === 'api-key' ? 'anthropicApiKey' : 'claudeOAuthToken'] = secret.trim();
      if (hermesKey.trim()) body.hermesApiKey = hermesKey.trim();
      const changedConnection = !!secret.trim() || !!hermesKey.trim() || (agent === 'hermes' && hermesUrl.trim() !== (s?.hermesUrlSource === 'settings' ? s.hermesUrl : ''));
      setS(await api<PublicSettings>('/api/settings', { method: 'PUT', json: body }));
      setSecret('');
      setHermesKey('');
      onSaved();
      if (changedConnection) await runTest(agent);
    } finally {
      setBusy(false);
    }
  };

  const clearCreds = async () => {
    if (!confirm('Remove the saved Claude credential?')) return;
    setS(await api<PublicSettings>('/api/settings', { method: 'PUT', json: { anthropicApiKey: '', claudeOAuthToken: '' } }));
    onSaved();
  };

  const clearHermesKey = async () => {
    if (!confirm('Remove the saved Hermes API key?')) return;
    setS(await api<PublicSettings>('/api/settings', { method: 'PUT', json: { hermesApiKey: '' } }));
    onSaved();
  };

  const logout = async () => {
    await api('/api/logout', { method: 'POST' });
    location.reload();
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 id="settings-title">Settings</h3>
          <button className="ghost icon" onClick={onClose} aria-label="Close"><Close /></button>
        </div>
        {!s ? (
          <div className="modal-body muted">Loading…</div>
        ) : (
          <div className="modal-body">
            <section>
              <h4>Assistant</h4>
              <p className="muted small">Who answers in the chat. Projects, history and exports work the same with either.</p>
              <div className="seg">
                <button className={agent === 'claude' ? 'on' : ''} onClick={() => { setAgent('claude'); setTest(null); }}>Claude Code</button>
                <button className={agent === 'hermes' ? 'on' : ''} onClick={() => { setAgent('hermes'); setTest(null); }}>Hermes</button>
              </div>
            </section>

            {agent === 'claude' ? (
              <>
                <section>
                  <h4>Claude connection</h4>
                  <p className="muted small">
                    Status:{' '}
                    {s.auth.mode === 'none' ? (
                      <b className="bad">not connected</b>
                    ) : (
                      <b className="good">
                        <i className="tick" />
                        {s.auth.mode === 'api-key' ? 'API key' : 'Claude subscription token'} ({s.auth.source === 'env' ? 'from container variable' : 'saved here'})
                      </b>
                    )}
                    {(s.anthropicApiKey || s.claudeOAuthToken) && <span> · {s.anthropicApiKey || s.claudeOAuthToken}</span>}
                  </p>
                  <div className="seg">
                    <button className={mode === 'oauth-token' ? 'on' : ''} onClick={() => setMode('oauth-token')}>Subscription</button>
                    <button className={mode === 'api-key' ? 'on' : ''} onClick={() => setMode('api-key')}>API key</button>
                  </div>
                  {mode === 'oauth-token' ? (
                    <p className="muted small">
                      Uses a Claude Pro or Max plan. On any computer with Claude Code installed, run <code>claude setup-token</code>, sign in, and paste the token it
                      prints (starts with <code>sk-ant-oat</code>). It's valid for a year.
                    </p>
                  ) : (
                    <p className="muted small">Pay-as-you-go billing from the Anthropic Console (console.anthropic.com → API keys). Starts with <code>sk-ant-api</code>.</p>
                  )}
                  <input type="password" placeholder={mode === 'api-key' ? 'sk-ant-api…' : 'sk-ant-oat…'} value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
                  <div className="row">
                    <button className="small" onClick={() => void runTest('claude')} disabled={s.auth.mode === 'none'}>Test connection</button>
                    {(s.anthropicApiKey || s.claudeOAuthToken) && <button className="ghost small" onClick={clearCreds}>Remove credential…</button>}
                  </div>
                </section>
                <section>
                  <h4>Model</h4>
                  <div className="row" style={{ marginTop: 0 }}>
                    <select value={MODELS.some((m) => m.id === model) ? model : 'custom'} onChange={(e) => setModel(e.target.value === 'custom' ? model || 'claude-' : e.target.value)}>
                      {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                      <option value="custom">Custom model id…</option>
                    </select>
                    {!MODELS.some((m) => m.id === model) && <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id" />}
                  </div>
                </section>
              </>
            ) : (
              <section>
                <h4>Hermes connection</h4>
                <p className="muted small">
                  Connects to a Hermes Agent gateway's API server. On the Hermes host set <code>API_SERVER_ENABLED=true</code> and an <code>API_SERVER_KEY</code>,
                  set <code>API_SERVER_HOST=0.0.0.0</code> if Splat runs in another container, then run <code>hermes gateway</code>. Hermes edits the model through
                  Splat, so it needs no access to this server's files.
                </p>
                <label className="field">
                  <span>Gateway URL</span>
                  <input
                    type="url"
                    value={hermesUrl}
                    onChange={(e) => setHermesUrl(e.target.value)}
                    placeholder={s.hermesUrlSource === 'env' ? `${s.hermesUrl} (from container variable)` : 'http://hermes:8642'}
                  />
                </label>
                <label className="field">
                  <span>API key {s.hermesApiKey && <small>· saved {s.hermesApiKey}</small>}</span>
                  <input type="password" value={hermesKey} onChange={(e) => setHermesKey(e.target.value)} placeholder="API_SERVER_KEY" autoComplete="off" />
                </label>
                <label className="field">
                  <span>Model <small>(optional; empty uses the gateway's model)</small></span>
                  <input value={hermesModel} onChange={(e) => setHermesModel(e.target.value)} placeholder="hermes-agent" />
                </label>
                <div className="row">
                  <button className="small" onClick={() => void runTest('hermes')} disabled={!hermesUrl.trim() && s.hermesUrlSource !== 'env'}>Test connection</button>
                  {s.hermesApiKey && <button className="ghost small" onClick={clearHermesKey}>Remove key…</button>}
                </div>
              </section>
            )}
            {test && <div className={test.ok ? 'ok-msg' : 'chat-error'} style={{ margin: '0 0 8px' }}>{test.message}{test.model ? ` · model ${test.model}` : ''}</div>}

            <section>
              <h4>Your printer</h4>
              <p className="muted small">The assistant takes this into account for every design (bed size, nozzle, material, tolerances that work for you).</p>
              <textarea rows={3} value={printer} onChange={(e) => setPrinter(e.target.value)} placeholder="e.g. Bambu P1S, 256×256×256 bed, 0.4 mm nozzle, PLA/PETG, 0.2 mm clearance fits well" />
            </section>
            <section>
              <h4>Standing instructions</h4>
              <textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Prefer M3 heat-set inserts. Chamfer all bottom edges 0.6 mm. Use BOSL2." />
            </section>
            <div className="row end">
              <button className="ghost" onClick={onClose}>Cancel</button>
              <button className="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
            </div>
            {status && (
              <section className="about muted small" style={{ marginTop: 18 }}>
                Splat {status.version} · OpenSCAD {status.openscad.version}
                {status.openscad.manifold ? ' (Manifold)' : ''} · data in {status.dataDir}
                <span className="spacer" />
                <button className="link" onClick={logout}>Log out</button>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
