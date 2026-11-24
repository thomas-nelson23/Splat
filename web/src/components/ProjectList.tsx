import { useEffect, useState } from 'react';
import { api, P, timeAgo, type ProjectMeta } from '../api';

interface Props {
  onOpen: (id: string, firstMessage?: string) => void;
  onSettings: () => void;
  claudeReady: boolean;
}

export function ProjectList({ onOpen, onSettings, claudeReady }: Props) {
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [idea, setIdea] = useState('');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);

  const load = () => api<ProjectMeta[]>('/api/projects').then(setProjects);
  useEffect(() => {
    void load();
  }, []);

  const create = async (name: string, firstMessage?: string) => {
    setBusy(true);
    try {
      const p = await api<ProjectMeta>('/api/projects', { json: { name } });
      onOpen(p.id, firstMessage);
    } finally {
      setBusy(false);
    }
  };

  const fromIdea = () => {
    const text = idea.trim();
    if (!text) return;
    const name = text.replace(/^(make|design|create|build|model)\s+(me\s+)?(an?\s+|the\s+)?/i, '').split(/[.,;\n]| with | for /)[0].slice(0, 40).trim();
    void create(name ? name[0].toUpperCase() + name.slice(1) : 'New part', text);
  };

  const rename = async (p: ProjectMeta) => {
    const name = prompt('Rename project', p.name);
    if (!name) return;
    await api(P(p.id), { method: 'PATCH', json: { name } });
    void load();
  };
  const duplicate = async (p: ProjectMeta) => {
    await api(`${P(p.id)}/duplicate`, { json: { name: `${p.name} copy` } });
    void load();
  };
  const remove = async (p: ProjectMeta) => {
    if (!confirm(`Delete "${p.name}"? It's moved to projects/.trash in appdata, so it can be recovered.`)) return;
    await api(P(p.id), { method: 'DELETE' });
    void load();
  };

  return (
    <div className="home" onClick={() => setMenu(null)}>
      <header className="topbar">
        <div className="brand"><img src="/icon.svg" alt="" width={26} height={26} /> Splat</div>
        <span className="spacer" />
        <button className="ghost" onClick={onSettings}>Settings</button>
      </header>
      <div className="home-inner">
        <div className="hero">
          <h1>What do you want to make?</h1>
          {!claudeReady && (
            <div className="notice">
              Connect Claude first: <button className="link" onClick={onSettings}>open Settings</button>.
            </div>
          )}
          <div className="idea">
            <textarea
              value={idea}
              rows={2}
              placeholder="e.g. A box for 18650 cells, 4×5 grid, with a sliding lid"
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  fromIdea();
                }
              }}
            />
            <div className="row">
              <button className="primary" disabled={busy || !idea.trim()} onClick={fromIdea}>Start designing</button>
              <button className="ghost" disabled={busy} onClick={() => { const n = prompt('Project name', 'New part'); if (n) void create(n); }}>
                Blank project
              </button>
            </div>
          </div>
        </div>
        <h3 className="section-title">Projects</h3>
        {projects === null ? (
          <div className="muted">Loading…</div>
        ) : projects.length === 0 ? (
          <div className="muted">No projects yet.</div>
        ) : (
          <div className="grid">
            {projects.map((p) => (
              <div key={p.id} className="card" onClick={() => onOpen(p.id)}>
                <div className="thumb">
                  {p.thumbnail ? <img src={`${P(p.id)}/thumbnail?v=${encodeURIComponent(p.updatedAt)}`} alt="" /> : <span>◇</span>}
                </div>
                <div className="card-body">
                  <div className="card-title">{p.name}</div>
                  <div className="muted small">{timeAgo(p.updatedAt)}</div>
                </div>
                <button
                  className="ghost card-menu-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu(menu === p.id ? null : p.id);
                  }}
                >
                  ⋯
                </button>
                {menu === p.id && (
                  <div className="card-menu" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => rename(p)}>Rename</button>
                    <button onClick={() => duplicate(p)}>Duplicate</button>
                    <button className="danger-text" onClick={() => remove(p)}>Delete</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
