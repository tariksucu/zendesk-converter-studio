import { DEFAULT_BASE } from './api';

/**
 * The installation's settings (`client.metadata().settings`, manifest.json's `parameters`).
 * The API key is a secure setting: it is never in here, only Zendesk's proxy reads it.
 */
export interface Settings {
  /** The most credits one conversion may use; dearer conversions are refused, uncharged. */
  readonly maxCredits: number;
  /** The API's root (a hidden setting, for testing); Zendesk sends the key to converter.studio only. */
  readonly baseUrl: string;
}

export const DEFAULT_MAX_CREDITS = 10;
const MAX_MAX_CREDITS = 1000;

export function readSettings(raw: Readonly<Record<string, unknown>> | undefined): Settings {
  return { maxCredits: maxCreditsOf(raw?.maxCredits), baseUrl: baseUrlOf(raw?.baseUrl) };
}

function maxCreditsOf(value: unknown): number {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(number)) return DEFAULT_MAX_CREDITS;
  return Math.min(MAX_MAX_CREDITS, Math.max(1, Math.floor(number)));
}

function baseUrlOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_BASE;
  try {
    const url = new URL(value.trim());
    // A plain web address (http only for a local test server).
    if (!/^https?:$/.test(url.protocol)) return DEFAULT_BASE;
    if (url.username || url.password || url.search || url.hash) return DEFAULT_BASE;
    return url.href.replace(/\/+$/, '');
  } catch {
    return DEFAULT_BASE;
  }
}
