import fs from 'node:fs';
import { SETTINGS_FILE } from './config.js';

export interface Settings {
  /** Anthropic API key (pay as you go). */
  anthropicApiKey?: string;
  /** Long-lived token from `claude setup-token` (uses a Claude Pro/Max subscription). */
  claudeOAuthToken?: string;
  /** Model alias or id passed to Claude Code, e.g. "opus", "sonnet". Empty = Claude Code default. */
  model?: string;
  /** Extra instructions appended to every chat (house style, printer, tolerances...). */
  customInstructions?: string;
  /** Printer / slicer context shown to Claude. */
  printerProfile?: string;
}

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Settings;
  } catch {
    cache = {};
  }
  return cache!;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings() };
  for (const [k, v] of Object.entries(patch) as [keyof Settings, string | undefined][]) {
    if (v === undefined) continue;
    if (v === '' || v === null) delete next[k];
    else next[k] = v;
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  return next;
}

export type AuthMode = 'api-key' | 'oauth-token' | 'none';

/** Resolve the credentials Claude Code should use. Values saved in the UI win over env vars. */
export function claudeAuth(): { mode: AuthMode; env: Record<string, string>; source: string } {
  const s = getSettings();
  if (s.claudeOAuthToken) return { mode: 'oauth-token', env: { CLAUDE_CODE_OAUTH_TOKEN: s.claudeOAuthToken }, source: 'settings' };
  if (s.anthropicApiKey) return { mode: 'api-key', env: { ANTHROPIC_API_KEY: s.anthropicApiKey }, source: 'settings' };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
    return { mode: 'oauth-token', env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }, source: 'env' };
  if (process.env.ANTHROPIC_API_KEY)
    return { mode: 'api-key', env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }, source: 'env' };
  return { mode: 'none', env: {}, source: 'none' };
}

const mask = (v?: string) => (v ? `${v.slice(0, 7)}…${v.slice(-4)}` : '');

export function publicSettings() {
  const s = getSettings();
  const auth = claudeAuth();
  return {
    model: s.model ?? process.env.CLAUDE_MODEL ?? '',
    customInstructions: s.customInstructions ?? '',
    printerProfile: s.printerProfile ?? '',
    anthropicApiKey: mask(s.anthropicApiKey),
    claudeOAuthToken: mask(s.claudeOAuthToken),
    auth: { mode: auth.mode, source: auth.source },
  };
}
