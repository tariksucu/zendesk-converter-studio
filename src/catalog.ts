import type { ConversionOptions, ConverterApi, FormatInfo } from './api';

/**
 * What each attachment can become, from the API's own format list (`GET /v1/formats`): a
 * target is offered only when the server lists it for that format now.
 */

/** A result to offer: the API's target and the options that make it what the label says. */
export interface Target {
  /** Unique within one list. */
  readonly key: string;
  readonly to: string;
  readonly label: string;
  readonly options: ConversionOptions;
}

/** OCR targets of a picture: plain text or a Word file of the recognised text. */
const RECOGNISED = new Set(['txt', 'docx']);

/** Content types whose subtype is not the format's id or an extension. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/heif': 'heic',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'audio/mpeg': 'mp3',
  'text/plain': 'txt',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

export class Catalog {
  private readonly byId = new Map<string, FormatInfo>();
  private readonly byExtension = new Map<string, FormatInfo>();

  constructor(readonly formats: readonly FormatInfo[]) {
    for (const format of formats) {
      this.byId.set(format.id, format);
      for (const extension of format.extensions)
        this.byExtension.set(extension.toLowerCase(), format);
    }
  }

  get(id: string): FormatInfo | undefined {
    return this.byId.get(id);
  }

  name(id: string): string {
    return this.byId.get(id)?.name ?? id.toUpperCase();
  }

  /** A file's format: by its name's extension, or else by its content type. */
  formatOf(file: { readonly name: string; readonly contentType?: string }): FormatInfo | undefined {
    const name = file.name.trim().toLowerCase();
    // Two-part extensions first (`.tar.gz`).
    for (const extension of [/\.([a-z0-9]+\.[a-z0-9]+)$/, /\.([a-z0-9]+)$/]) {
      const match = extension.exec(name);
      const format = match ? this.byExtension.get(match[1]!) : undefined;
      if (format) return format;
    }
    const type = (file.contentType ?? '').split(';')[0]!.trim().toLowerCase();
    if (!type) return undefined;
    const id = CONTENT_TYPES[type] ?? type.split('/')[1];
    return id ? (this.byId.get(id) ?? this.byExtension.get(id)) : undefined;
  }

  /**
   * Everything the server makes of a format, most used first. PDF to PDF is the server's "make
   * it smaller"; pictures to TXT or DOCX are text recognition.
   */
  targets(format: FormatInfo | undefined): Target[] {
    if (!format) return [];
    return format.to.map((to): Target => {
      if (to === format.id)
        return {
          key: to,
          to,
          label: `${this.name(to)} (smaller file)`,
          options: to === 'pdf' ? { compression: 'balanced' } : {},
        };
      if (format.category === 'image' && RECOGNISED.has(to))
        return { key: to, to, label: `${this.name(to)} (text from the picture)`, options: {} };
      return { key: to, to, label: this.name(to), options: {} };
    });
  }
}

/** Results a browser shows by itself (the API's `inline=1` list): "Open" next to "Download". */
const OPENS_IN_BROWSER = new Set([
  'pdf',
  'jpg',
  'png',
  'gif',
  'webp',
  'avif',
  'bmp',
  'mp4',
  'webm',
  'mp3',
  'wav',
  'ogg',
  'opus',
  'm4a',
  'aac',
  'flac',
]);

/** The result's link for viewing in a tab, or null when it downloads only (or is a ZIP). */
export function viewUrl(downloadUrl: string, to: string, outputName: string): string | null {
  if (!OPENS_IN_BROWSER.has(to) || outputName.toLowerCase().endsWith('.zip')) return null;
  return `${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}inline=1`;
}

/** Where the format list is kept between sidebars (the browser's storage; may be missing). */
const CACHE_KEY = 'converter-studio:formats';
/** The list changes only when the server does. */
const CACHE_MS = 6 * 60 * 60 * 1000;

interface CachedFormats {
  readonly base: string;
  readonly at: number;
  readonly formats: readonly FormatInfo[];
}

/** The format list: from the browser's storage while it is fresh, otherwise from the API. */
export async function loadCatalog(
  api: ConverterApi,
  storage: Storage | null = safeStorage(),
  now: number = Date.now(),
): Promise<Catalog> {
  try {
    const raw = storage?.getItem(CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw) as CachedFormats;
      if (
        cached.base === api.base &&
        now - cached.at < CACHE_MS &&
        now >= cached.at &&
        Array.isArray(cached.formats) &&
        cached.formats.length > 0
      )
        return new Catalog(cached.formats);
    }
  } catch {
    // A broken or unreadable copy: fetch it again.
  }
  const formats = await api.formats();
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify({ base: api.base, at: now, formats }));
  } catch {
    // Storage full or refused: the next sidebar fetches the list again.
  }
  return new Catalog(formats);
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / (1000 * 1000)).toFixed(1).replace(/\.0$/, '')} MB`;
}
