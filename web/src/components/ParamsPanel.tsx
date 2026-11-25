import { useEffect, useMemo, useRef, useState } from 'react';
import { api, P, type ParamValue, type ScadParam } from '../api';

interface Props {
  projectId: string;
  refreshKey: number;
  onOverrides?: (count: number) => void;
}

export function ParamsPanel({ projectId, refreshKey, onOverrides }: Props) {
  const [params, setParams] = useState<ScadParam[]>([]);
  const [overrides, setOverrides] = useState<Record<string, ParamValue>>({});
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let live = true;
    api<{ params: ScadParam[]; overrides: Record<string, ParamValue> }>(`${P(projectId)}/params`)
      .then((r) => {
        if (!live) return;
        setParams(r.params);
        setOverrides(r.overrides);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [projectId, refreshKey]);

  const groups = useMemo(() => {
    const g = new Map<string, ScadParam[]>();
    for (const p of params) {
      if (!g.has(p.group)) g.set(p.group, []);
      g.get(p.group)!.push(p);
    }
    return [...g.entries()];
  }, [params]);

  const push = (next: Record<string, ParamValue>) => {
    setOverrides(next);
    onOverrides?.(Object.keys(next).length);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void api(`${P(projectId)}/params`, { method: 'PUT', json: { overrides: next } });
    }, 250);
  };

  const set = (p: ScadParam, v: ParamValue) => {
    const next = { ...overrides };
    if (JSON.stringify(v) === JSON.stringify(p.value)) delete next[p.name];
    else next[p.name] = v;
    push(next);
  };

  const apply = async () => {
    await api(`${P(projectId)}/params/apply`, { method: 'POST' });
    setOverrides({});
    onOverrides?.(0);
    setMsg('Saved into the file as new defaults.');
    setTimeout(() => setMsg(null), 3000);
  };

  if (loading) return <div className="panel-pad muted">Loading…</div>;
  if (!params.length)
    return (
      <div className="panel-pad muted">
        No customizer parameters found in the main file. Ask in the chat to "make the key dimensions parameters" and they'll show up here as sliders.
      </div>
    );

  const changed = Object.keys(overrides).length;
  return (
    <div className="params">
      <div className="params-actions">
        <span className="muted">{changed ? `${changed} changed (preview only)` : 'Tweak values; the preview updates live.'}</span>
        <span className="spacer" />
        <button className="ghost small" disabled={!changed} onClick={() => push({})}>Reset</button>
        <button className="primary small" disabled={!changed} onClick={apply} title="Write these values into the .scad file and save a version">
          Save as defaults
        </button>
      </div>
      {msg && <div className="ok-msg">{msg}</div>}
      {groups.map(([group, ps]) => (
        <fieldset key={group} className="param-group">
          <legend>{group}</legend>
          {ps.map((p) => {
            const v = overrides[p.name] ?? p.value;
            const isChanged = p.name in overrides;
            return (
              <label key={p.name} className={`param ${isChanged ? 'changed' : ''}`}>
                <div className="param-name">
                  <span>{p.name.replace(/_/g, ' ')}</span>
                  {p.description && <small>{p.description}</small>}
                </div>
                <ParamInput p={p} value={v} onChange={(nv) => set(p, nv)} />
              </label>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}

function ParamInput({ p, value, onChange }: { p: ScadParam; value: ParamValue; onChange: (v: ParamValue) => void }) {
  if (p.options) {
    return (
      <select value={String(value)} onChange={(e) => onChange(p.type === 'number' ? Number(e.target.value) : e.target.value)}>
        {p.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
        ))}
      </select>
    );
  }
  if (p.type === 'boolean') return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
  if (p.type === 'string')
    return <input type="text" value={String(value)} maxLength={p.maxLength} onChange={(e) => onChange(e.target.value)} />;
  if (p.type === 'vector') {
    const arr = value as number[];
    return (
      <div className="vec">
        {arr.map((x, i) => (
          <input
            key={i}
            type="number"
            value={x}
            step={p.step ?? 'any'}
            min={p.min}
            max={p.max}
            onChange={(e) => onChange(arr.map((y, j) => (j === i ? Number(e.target.value) : y)))}
          />
        ))}
      </div>
    );
  }
  const num = Number(value);
  const hasRange = p.min !== undefined && p.max !== undefined;
  return (
    <div className="num">
      {hasRange && (
        <input type="range" min={p.min} max={p.max} step={p.step ?? (Number.isInteger(p.value) ? 1 : 0.1)} value={num} onChange={(e) => onChange(Number(e.target.value))} />
      )}
      <input type="number" value={num} step={p.step ?? 'any'} onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))} />
    </div>
  );
}
