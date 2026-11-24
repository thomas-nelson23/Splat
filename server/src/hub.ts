import type { WebSocket } from 'ws';

type Msg = Record<string, unknown> & { type: string };

const subs = new Map<string, Set<WebSocket>>();
const all = new Set<WebSocket>();

export function subscribe(ws: WebSocket, projectId: string | null) {
  all.add(ws);
  if (projectId) {
    if (!subs.has(projectId)) subs.set(projectId, new Set());
    subs.get(projectId)!.add(ws);
  }
  ws.on('close', () => {
    all.delete(ws);
    if (projectId) subs.get(projectId)?.delete(ws);
  });
}

export function send(ws: WebSocket, msg: Msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export function broadcast(projectId: string, msg: Msg) {
  const data = JSON.stringify({ ...msg, projectId });
  for (const ws of subs.get(projectId) ?? []) if (ws.readyState === ws.OPEN) ws.send(data);
}

export function broadcastAll(msg: Msg) {
  const data = JSON.stringify(msg);
  for (const ws of all) if (ws.readyState === ws.OPEN) ws.send(data);
}
