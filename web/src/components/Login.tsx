import { useState } from 'react';
import { api } from '../api';
import { HexMark, Wordmark } from './Glyphs';

export function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="login hex">
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
        <HexMark />
        <Wordmark />
        <input type="password" autoFocus placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
        {err && <div className="chat-error">{err}</div>}
        <button className="primary">Log in</button>
      </form>
    </div>
  );
}
