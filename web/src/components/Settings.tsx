import { useEffect, useState } from 'react';
import { api, type PublicSettings, type Status } from '../api';

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

export function Settings({ status, onClose, onSaved }: Props) {
  const [s, setS] = useState<PublicSettings | null>(null);
  const [mode, setMode] = useState<'oauth-token' | 'api-key'>('oauth-token');
  const [secret, setSecret] = useState('');
  const [model, setModel] = useState('');
  const [printer, setPrinter] = useState('');
  const [instructions, setInstructions] = useState('');
  const [test, setTest] = useState<{ ok: boolean; message: string; model?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<PublicSettings>('/api/settings').then((r) => {
      setS(r);
      if (r.auth.mode !== 'none') setMode(r.auth.mode);
      setModel(r.model);
      setPrinter(r.printerProfile);
      setInstructions(r.customInstructions);
    });
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, string> = { model, printerProfile: printer, customInstructions: instructions };
      if (secret.trim()) body[mode === 'api-key' ? 'anthropicApiKey' : 'claudeOAuthToken'] = secret.trim();
      setS(await api<PublicSettings>('/api/settings', { method: 'PUT', json: body }));
      setSecret('');
      onSaved();
      if (secret.trim()) await runTest();
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTest({ ok: true, message: 'Testing…' });
    setTest(await api('/api/settings/test', { method: 'POST' }));
  };

  const clearCreds = async () => {
    if (!confirm('Remove the saved credential?')) return;
    setS(await api<PublicSettings>('/api/settings', { method: 'PUT', json: { anthropicApiKey: '', claudeOAuthToken: '' } }));
    onSaved();
  };

  const logout = async () => {
    await api('/api/logout', { method: 'POST' });
    location.reload();
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Settings</h3>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        {!s ? (
          <div className="muted">Loading…</div>
        ) : (
          <div className="modal-body">
            <section>
              <h4>Claude connection</h4>
              <p className="muted small">
                Status:{' '}
                {s.auth.mode === 'none' ? (
                  <b className="bad">not connected</b>
                ) : (
                  <b className="good">
                    {s.auth.mode === 'api-key' ? 'API key' : 'Claude subscription token'} ({s.auth.source === 'env' ? 'from container variable' : 'saved here'})
                  </b>
                )}
                {(s.anthropicApiKey || s.claudeOAuthToken) && <span> · {s.anthropicApiKey || s.claudeOAuthToken}</span>}
              </p>
              <div className="seg">
                <button className={mode === 'oauth-token' ? 'on' : ''} onClick={() => setMode('oauth-token')}>Claude subscription</button>
                <button className={mode === 'api-key' ? 'on' : ''} onClick={() => setMode('api-key')}>API key</button>
              </div>
              {mode === 'oauth-token' ? (
                <p className="muted small">
                  Uses your Claude Pro or Max plan. On any computer with Claude Code installed, run <code>claude setup-token</code>, sign in, and paste
                  the token it prints (starts with <code>sk-ant-oat</code>). It's valid for a year.
                </p>
              ) : (
                <p className="muted small">
                  Pay-as-you-go billing from the Anthropic Console (console.anthropic.com → API keys). Starts with <code>sk-ant-api</code>.
                </p>
              )}
              <input
                type="password"
                placeholder={mode === 'api-key' ? 'sk-ant-api…' : 'sk-ant-oat…'}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="off"
              />
              <div className="row">
                <button className="ghost small" onClick={runTest} disabled={s.auth.mode === 'none'}>Test connection</button>
                {(s.anthropicApiKey || s.claudeOAuthToken) && <button className="ghost small" onClick={clearCreds}>Remove saved credential</button>}
              </div>
              {test && <div className={test.ok ? 'ok-msg' : 'chat-error'}>{test.message}{test.model ? ` · model ${test.model}` : ''}</div>}
            </section>
            <section>
              <h4>Model</h4>
              <div className="row">
                <select value={MODELS.some((m) => m.id === model) ? model : 'custom'} onChange={(e) => setModel(e.target.value === 'custom' ? model || 'claude-' : e.target.value)}>
                  {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  <option value="custom">Custom model id…</option>
                </select>
                {!MODELS.some((m) => m.id === model) && <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id" />}
              </div>
            </section>
            <section>
              <h4>Your printer</h4>
              <p className="muted small">Claude takes this into account for every design (bed size, nozzle, material, tolerances that work for you).</p>
              <textarea rows={3} value={printer} onChange={(e) => setPrinter(e.target.value)} placeholder="e.g. Bambu P1S, 256×256×256 bed, 0.4 mm nozzle, PLA/PETG, 0.2 mm clearance fits well" />
            </section>
            <section>
              <h4>Standing instructions</h4>
              <textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Prefer M3 heat-set inserts. Chamfer all bottom edges 0.6 mm. Use BOSL2." />
            </section>
            <div className="row end">
              <button className="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
            {status && (
              <section className="about muted small">
                Splat {status.version} · OpenSCAD {status.openscad.version}
                {status.openscad.manifold ? ' (Manifold)' : ''} · data in {status.dataDir}
                <button className="link" onClick={logout}>Log out</button>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
