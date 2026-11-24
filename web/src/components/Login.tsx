import { useState } from 'react';
import { api } from '../api';

export function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="login">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('/api/login', { json: { password: pw } });
            onDone();
          } catch {
            setErr('Wrong password');
          }
        }}
      >
        <img src="/icon.svg" alt="" width={64} height={64} />
        <h2>Splat</h2>
        <input type="password" autoFocus placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
        {err && <div className="chat-error">{err}</div>}
        <button className="primary">Log in</button>
      </form>
    </div>
  );
}
