import { useEffect, useRef, useState } from 'react';
import { api, fmtBytes, P, type FileEntry, type ProjectMeta } from '../api';

interface ImportResult {
  name: string;
  ok: boolean;
  error?: string;
  file?: string;
  snippet?: string;
  info?: { size: number[]; triangles: number; watertight: boolean } | null;
}

interface Props {
  project: ProjectMeta;
  refreshKey: number;
  onOpen: (path: string) => void;
  onAskClaude: (text: string) => void;
  accept: string;
}

export async function uploadFiles(projectId: string, files: FileList | File[]): Promise<ImportResult[]> {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  return api<ImportResult[]>(`${P(projectId)}/import`, { method: 'POST', body: fd });
}

export function FilesPanel({ project, refreshKey, onOpen, onAskClaude, accept }: Props) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ImportResult[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const load = () => api<FileEntry[]>(`${P(project.id)}/files`).then(setFiles);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, refreshKey]);

  const doUpload = async (list: FileList | File[]) => {
    setBusy(true);
    try {
      setResults(await uploadFiles(project.id, list));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const setMain = async (path: string) => {
    await api(P(project.id), { method: 'PATCH', json: { main: path } });
    window.dispatchEvent(new Event('splat:project-changed'));
  };

  const del = async (path: string) => {
    if (!confirm(`Delete ${path}? (It stays in version history.)`)) return;
    await api(`${P(project.id)}/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    await load();
  };

  const newFile = async () => {
    const name = prompt('New file name', 'part.scad');
    if (!name) return;
    await api(`${P(project.id)}/file?path=${encodeURIComponent(name)}`, { method: 'PUT', body: '// ' + name + '\n', headers: { 'Content-Type': 'text/plain' } });
    await load();
    onOpen(name);
  };

  return (
    <div
      className="files"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) void doUpload(e.dataTransfer.files);
      }}
    >
      <div className="dropzone" onClick={() => input.current?.click()}>
        {busy ? 'Importing…' : 'Drop files here or click to import'}
        <small>STL, 3MF, OBJ, STEP, SVG, DXF, PNG heightmaps, fonts, .scad</small>
        <input ref={input} type="file" multiple hidden accept={accept} onChange={(e) => e.target.files && void doUpload(e.target.files)} />
      </div>
      {results.map((r) => (
        <div key={r.name} className={`import-result ${r.ok ? '' : 'err'}`}>
          {r.ok ? (
            <>
              <div>
                Imported <b>{r.file}</b>
                {r.info?.size && <span className="muted"> · {r.info.size.map((n) => n.toFixed(1)).join(' × ')} mm</span>}
              </div>
              <code>{r.snippet}</code>
              <button
                className="primary small"
                onClick={() =>
                  onAskClaude(
                    `I imported ${r.file}${r.info?.size ? ` (${r.info.size.map((n) => n.toFixed(1)).join(' × ')} mm)` : ''}. `,
                  )
                }
              >
                Ask Claude to use it
              </button>
            </>
          ) : (
            <div>Couldn't import {r.name}: {r.error}</div>
          )}
        </div>
      ))}
      <div className="file-list-head">
        <span>Project files</span>
        <button className="ghost small" onClick={newFile}>New .scad</button>
      </div>
      <ul className="file-list">
        {files.map((f) => (
          <li key={f.path}>
            <button className="file-name" onClick={() => (f.path.endsWith('.scad') || f.path.endsWith('.json') ? onOpen(f.path) : window.open(`${P(project.id)}/file?path=${encodeURIComponent(f.path)}&download=1`))}>
              {f.path}
              {f.path === project.main && <span className="badge">main</span>}
            </button>
            <span className="muted">{fmtBytes(f.size)}</span>
            <span className="file-actions">
              {f.path.endsWith('.scad') && f.path !== project.main && (
                <button className="ghost tiny" onClick={() => setMain(f.path)} title="Show this file in the preview">Set main</button>
              )}
              <a className="ghost tiny" href={`${P(project.id)}/file?path=${encodeURIComponent(f.path)}&download=1`}>⇩</a>
              {f.path !== project.main && f.path !== 'project.json' && (
                <button className="ghost tiny" onClick={() => del(f.path)}>✕</button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
