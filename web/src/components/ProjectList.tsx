import { useEffect, useState } from 'react';
import { agentName, api, P, timeAgo, type AgentKind, type ProjectMeta } from '../api';
import { Gear, HexMark, More, Wordmark } from './Glyphs';

interface Props {
  onOpen: (id: string, firstMessage?: string) => void;
  onSettings: () => void;
  agentReady: boolean;
  agent: AgentKind;
}

export function ProjectList({ onOpen, onSettings, agentReady, agent }: Props) {
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
    <div className="home hex" onClick={() => setMenu(null)}>
      <header className="topbar">
        <div className="brand"><HexMark /><Wordmark /></div>
        <span className="spacer" />
        <span className="agent-pill">{agentName(agent)}</span>
        <button className="ghost icon" onClick={onSettings} title="Settings" aria-label="Settings"><Gear /></button>
      </header>
      <div className="home-inner">
        <div className="hero">
          <div className="eyebrow">New part</div>
          <h1>What do you want to make?</h1>
          {!agentReady && (
            <div className="notice">
              Connect {agentName(agent)} first: <button className="link" onClick={onSettings}>open Settings</button>.
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
          <div className="project-grid">
            {projects.map((p) => (
              <div key={p.id} className="card-wrap">
              <div className="card" onClick={() => onOpen(p.id)}>
                <div className="thumb">
                  {p.thumbnail ? <img src={`${P(p.id)}/thumbnail?v=${encodeURIComponent(p.updatedAt)}`} alt="" /> : <HexMark />}
                </div>
                <div className="card-body">
                  <div className="card-title">{p.name}</div>
                  <div className="muted small">{timeAgo(p.updatedAt)}</div>
                </div>
              </div>
                <button
                  className="small icon card-menu-btn"
                  aria-label="Project actions"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu(menu === p.id ? null : p.id);
                  }}
                >
                  <More />
                </button>
                {menu === p.id && (
                  <div className="card-menu" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => rename(p)}>Rename…</button>
                    <button onClick={() => duplicate(p)}>Duplicate</button>
                    <div className="sep" />
                    <button className="danger-text" onClick={() => remove(p)}>Delete…</button>
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
