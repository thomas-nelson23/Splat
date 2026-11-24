import { useEffect, useRef } from 'react';

type Handler = (msg: any) => void;

/** Subscribe to server events for a project, reconnecting automatically. */
export function useProjectSocket(projectId: string | null, onMessage: Handler, onReconnect?: () => void) {
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const reconnect = useRef(onReconnect);
  reconnect.current = onReconnect;

  useEffect(() => {
    if (!projectId) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: number | undefined;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws?project=${encodeURIComponent(projectId)}`);
      ws.onopen = () => {
        if (attempt > 0) reconnect.current?.();
        attempt = 0;
      };
      ws.onmessage = (e) => {
        try {
          handler.current(JSON.parse(e.data));
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        attempt++;
        timer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** attempt));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [projectId]);
}
