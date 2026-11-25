import { useCallback, useEffect, useState } from 'react';
import { api, type Status } from './api';
import { ProjectList } from './components/ProjectList';
import { Workspace } from './components/Workspace';
import { Settings } from './components/Settings';
import { Login } from './components/Login';

function parseHash() {
  const m = location.hash.match(/^#\/p\/([a-z0-9-]+)/);
  return m ? m[1] : null;
}

export function App() {
  const [auth, setAuth] = useState<'checking' | 'login' | 'ok'>('checking');
  const [projectId, setProjectId] = useState<string | null>(parseHash());
  const [firstMessage, setFirstMessage] = useState<string | undefined>();
  const [status, setStatus] = useState<Status | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const loadStatus = useCallback(() => api<Status>('/api/status').then(setStatus).catch(() => null), []);

  useEffect(() => {
    api<{ required: boolean; authed: boolean }>('/api/auth').then((a) => setAuth(a.authed ? 'ok' : 'login'));
    const unauth = () => setAuth('login');
    window.addEventListener('splat:unauthorized', unauth);
    const onHash = () => setProjectId(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('splat:unauthorized', unauth);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  useEffect(() => {
    if (auth === 'ok') void loadStatus();
  }, [auth, loadStatus]);

  useEffect(() => {
    if (status && !status.agentReady && !sessionStorage.getItem('splat-settings-shown')) {
      sessionStorage.setItem('splat-settings-shown', '1');
      setSettingsOpen(true);
    }
  }, [status]);

  if (auth === 'checking') return null;
  if (auth === 'login') return <Login onDone={() => setAuth('ok')} />;

  const open = (id: string, first?: string) => {
    setFirstMessage(first);
    location.hash = `#/p/${id}`;
  };

  return (
    <>
      {projectId ? (
        <Workspace
          key={projectId}
          projectId={projectId}
          status={status}
          firstMessage={firstMessage}
          onBack={() => {
            setFirstMessage(undefined);
            location.hash = '#/';
          }}
          onSettings={() => setSettingsOpen(true)}
        />
      ) : (
        <ProjectList onOpen={open} onSettings={() => setSettingsOpen(true)} agentReady={status ? status.agentReady : true} agent={status?.agent ?? 'claude'} />
      )}
      {settingsOpen && <Settings status={status} onClose={() => setSettingsOpen(false)} onSaved={loadStatus} />}
    </>
  );
}
