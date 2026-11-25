import { preview } from './preview.js';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

/** Render the project's main file the way the live preview does and describe the result in plain text for an agent. */
export async function renderReport(projectId: string): Promise<{ text: string; isError: boolean }> {
  const p = preview(projectId);
  const waiting = p.next();
  p.schedule(0);
  const s = await waiting;
  const lines = [`status: ${s.status}${s.kind ? ` (${s.kind})` : ''}`, `render time: ${((s.durationMs ?? 0) / 1000).toFixed(1)}s`];
  if (s.stats)
    lines.push(
      `bounding box: min [${s.stats.min.join(', ')}] max [${s.stats.max.join(', ')}]`,
      `size (x, y, z): ${s.stats.size.join(' x ')} mm`,
      `volume: ${(s.stats.volume / 1000).toFixed(2)} cm³, triangles: ${s.stats.triangles}`,
    );
  if (s.kind === '2d') lines.push('top level object is 2D; preview shows it as a flat SVG shape.');
  if (s.kind === 'empty') lines.push('WARNING: the top level object is empty, nothing will be exported.');
  if (s.log?.errors.length) lines.push('errors:', ...s.log.errors.slice(0, 30));
  if (s.log?.warnings.length) lines.push('warnings:', ...s.log.warnings.slice(0, 30));
  if (s.log?.echoes.length) lines.push('echo:', ...s.log.echoes.slice(0, 40));
  if (s.status === 'error' && !s.log?.errors.length) lines.push('log tail:', ...(s.log?.raw ?? '').split('\n').slice(-25));
  return { text: clip(lines.join('\n'), 8000), isError: s.status === 'error' };
}
