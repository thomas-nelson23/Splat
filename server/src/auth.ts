import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import { DATA_DIR } from './config.js';

const secretFile = path.join(DATA_DIR, '.secret');
let secret: Buffer;
try {
  secret = fs.readFileSync(secretFile);
} catch {
  secret = crypto.randomBytes(32);
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
}

const PASSWORD = process.env.APP_PASSWORD ?? '';
export const authEnabled = () => PASSWORD.length > 0;
const COOKIE = 'splat_session';

function sign(payload: string) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function makeToken(payload: object, ttlSeconds: number) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function readToken<T = Record<string, unknown>>(token: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (data.exp < Date.now() / 1000) return null;
  return data as T;
}

export function checkPassword(pw: string) {
  const a = crypto.createHash('sha256').update(pw).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

export function setSession(res: Response) {
  res.cookie(COOKIE, makeToken({ u: 'owner' }, 60 * 60 * 24 * 30), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}

export function clearSession(res: Response) {
  res.clearCookie(COOKIE);
}

export function isAuthed(cookies: Record<string, string> | undefined) {
  if (!authEnabled()) return true;
  const t = cookies?.[COOKIE];
  return !!(t && readToken(t));
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isAuthed(req.cookies)) return next();
  res.status(401).json({ error: 'login required' });
}

/** Parse the Cookie header (for the WebSocket upgrade request). */
export function parseCookies(header?: string) {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
