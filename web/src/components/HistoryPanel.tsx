import { useEffect, useState } from 'react';
import { api, P, timeAgo, type Commit } from '../api';

interface Props {
  projectId: string;
  refreshKey: number;
  viewing: string | null;
  onView: (sha: string | null) => void;
}

export function HistoryPanel({ projectId, refreshKey, viewing, onView }: Props) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [diff, setDiff] = useState<{ sha: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<Commit[]>(`${P(projectId)}/history`).then(setCommits);
  }, [projectId, refreshKey]);

  const restore = async (c: Commit) => {
    if (!confirm(`Restore the project to "${c.message}"? This is saved as a new version, so nothing is lost.`)) return;
    setBusy(true);
    try {
      await api(`${P(projectId)}/history/${c.sha}/restore`, { method: 'POST' });
      onView(null);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const showDiff = async (c: Commit) => {
    if (diff?.sha === c.sha) return setDiff(null);
    const r = await api<{ diff: string }>(`${P(projectId)}/history/${c.sha}`);
    setDiff({ sha: c.sha, text: r.diff });
  };

  const saveVersion = async () => {
    const message = prompt('Name this version', 'Checkpoint');
    if (!message) return;
    const r = await api<{ commit: string | null }>(`${P(projectId)}/commit`, { json: { message } });
    if (!r.commit) alert('Nothing changed since the last version.');
  };

  return (
    <div className="history">
      <div className="params-actions">
        <span className="muted">Every Claude turn, edit and import is saved as a version.</span>
        <span className="spacer" />
        <button className="ghost small" onClick={saveVersion}>Save version</button>
      </div>
      <ul className="commits">
        {commits.map((c, i) => (
          <li key={c.sha} className={viewing === c.sha ? 'viewing' : ''}>
            <div className="commit-main" onClick={() => onView(i === 0 ? null : viewing === c.sha ? null : c.sha)}>
              <div className="commit-msg">{c.message.split('\n')[0]}</div>
              <div className="muted small">
                {timeAgo(c.date)} · {c.short}
                {i === 0 && <span className="badge">current</span>}
              </div>
            </div>
            <div className="commit-actions">
              <button className="ghost tiny" onClick={() => showDiff(c)}>{diff?.sha === c.sha ? 'Hide' : 'Changes'}</button>
              {i > 0 && (
                <>
                  <button className="ghost tiny" onClick={() => onView(viewing === c.sha ? null : c.sha)}>{viewing === c.sha ? 'Back' : 'Preview'}</button>
                  <button className="ghost tiny" disabled={busy} onClick={() => restore(c)}>Restore</button>
                </>
              )}
            </div>
            {diff?.sha === c.sha && (
              <pre className="diff">
                {diff.text.split('\n').map((l, j) => (
                  <span key={j} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>
                    {l + '\n'}
                  </span>
                ))}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
