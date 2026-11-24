import { useState } from 'react';
import { api, P, type ExportFormat } from '../api';

interface Props {
  projectId: string;
  formats: ExportFormat[];
  kind?: '3d' | '2d' | 'empty' | 'error';
  hasOverrides: boolean;
}

export function ExportPanel({ projectId, formats, kind, hasOverrides }: Props) {
  const [useParams, setUseParams] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orcaNote, setOrcaNote] = useState(false);

  const download = async (f: ExportFormat) => {
    setBusy(f.id);
    setError(null);
    try {
      const res = await fetch(`${P(projectId)}/export?format=${f.id}&params=${useParams ? 1 : 0}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      const blob = await res.blob();
      const name = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `model.${f.ext}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = decodeURIComponent(name);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
      setError(`${f.label}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const openInOrca = async () => {
    const { path } = await api<{ path: string }>(`${P(projectId)}/export-link`, { json: { format: '3mf' } });
    const url = `${location.origin}${path}`;
    window.location.href = `orcaslicer://open?file=${encodeURIComponent(url)}`;
    setOrcaNote(true);
  };

  const relevant = formats.filter((f) => f.dim === 'any' || kind === undefined || f.dim === (kind === '2d' ? '2d' : '3d'));
  const other = formats.filter((f) => !relevant.includes(f));

  return (
    <div className="export">
      <section className="orca">
        <h4>OrcaSlicer</h4>
        <div className="row">
          <button className="primary" disabled={!!busy} onClick={() => download(formats.find((f) => f.id === '3mf')!)}>
            {busy === '3mf' ? 'Exporting…' : 'Download 3MF'}
          </button>
          <button onClick={openInOrca} title="Asks OrcaSlicer on this computer to download and open the model">Open in OrcaSlicer</button>
        </div>
        {orcaNote && (
          <p className="muted small">
            If OrcaSlicer didn't open, it either isn't registered for orcaslicer:// links on this computer, or it can't reach this server
            (for example behind Cloudflare Access). Use Download 3MF and open the file instead.
          </p>
        )}
      </section>
      {hasOverrides && (
        <label className="check">
          <input type="checkbox" checked={useParams} onChange={(e) => setUseParams(e.target.checked)} />
          Use the current parameter values from the Parameters tab
        </label>
      )}
      {error && <div className="chat-error">{error}</div>}
      <ul className="formats">
        {relevant.map((f) => (
          <li key={f.id}>
            <div>
              <b>{f.label}</b>
              <div className="muted small">{f.description}</div>
            </div>
            <button className="small" disabled={!!busy} onClick={() => download(f)}>{busy === f.id ? '…' : 'Download'}</button>
          </li>
        ))}
      </ul>
      {other.length > 0 && (
        <details>
          <summary className="muted small">{kind === '2d' ? '3D formats (need a 3D model)' : '2D formats (need a 2D model or projection())'}</summary>
          <ul className="formats">
            {other.map((f) => (
              <li key={f.id}>
                <div>
                  <b>{f.label}</b>
                  <div className="muted small">{f.description}</div>
                </div>
                <button className="small" disabled={!!busy} onClick={() => download(f)}>{busy === f.id ? '…' : 'Download'}</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
