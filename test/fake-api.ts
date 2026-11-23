import type { Conversion, FormatInfo } from '../src/api';
import formatsFixture from './fixtures/formats.json';

/**
 * Converter Studio's REST API, in memory, for the unit tests. It keeps the real API's shapes and
 * the flow the app relies on: a link's conversion is `fetching` first, then (with `maxCredits`
 * under its price) `quoted` until confirmed; an upload converts on its own within `maxCredits`.
 */

export const BASE = 'https://converter.studio/api';
export const KEY = 'cvs_live_test_key_0123456789';
export const FORMATS = (formatsFixture as { formats: FormatInfo[] }).formats;

export interface ApiCall {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

interface FakeConversion {
  id: string;
  status: Conversion['status'];
  url: string | null;
  name: string | null;
  from: string | null;
  to: string;
  maxCredits: number;
  credits: number | null;
  progress: number | null;
  error: Conversion['error'];
  polls: number;
}

export interface ApiAnswer {
  readonly status: number;
  readonly body: unknown;
}

export class FakeApi {
  readonly calls: ApiCall[] = [];
  readonly conversions = new Map<string, FakeConversion>();
  readonly uploads = new Map<string, { name: string; size: number; received: number }>();
  /** Replays of an `Idempotency-Key`: the same conversion. */
  readonly keys = new Map<string, string>();
  credits = 120;
  /** What a link's file turns out to be (by default: its `name=` or path extension). */
  linkFrom: (url: string) => string | null = (url) => extensionFormat(nameOfLink(url));
  /** The price of every conversion. */
  price = 1;
  /** A link's file that cannot be fetched (Zendesk refused it). */
  linkFailure: Conversion['error'] = null;
  /** A conversion that fails while it runs. */
  conversionFailure: Conversion['error'] = null;
  /** Status requests a conversion stays `processing` for. */
  processingPolls = 1;
  /** Answer every call with this instead (a broken server). */
  override: ApiAnswer | null = null;
  private next = 1;

  handle(method: string, url: URL, headers: Record<string, string>, data?: string): ApiAnswer {
    const path = url.pathname.replace(/^\/api/, '');
    const body = data ? (JSON.parse(data) as unknown) : undefined;
    this.calls.push({ method, path: `${path}${url.search}`, headers, body });
    if (this.override) return this.override;
    if (headers.Authorization !== `Bearer ${KEY}`)
      return error(401, 'invalidApiKey', 'The API key is missing or not valid.');

    if (method === 'GET' && path === '/v1/formats')
      return { status: 200, body: { formats: FORMATS } };
    if (method === 'GET' && path === '/v1/account')
      return {
        status: 200,
        body: { email: 'owner@example.com', plan: 'pro', credits: this.credits, maxFileBytes: 1e9 },
      };
    if (method === 'POST' && path === '/v1/uploads') {
      const { fileName, size } = body as { fileName: string; size: number };
      const id = `up${this.next++}aaaaaaaa`;
      this.uploads.set(id, { name: fileName, size, received: 0 });
      return {
        status: 201,
        body: {
          id,
          uploadUrl: `${BASE}/v1/uploads/${id}?token=t_${id}`,
          method: 'PUT',
          maxBytes: 1e9,
          partBytes: 50_000_000,
          expiresAt: '2026-11-23T20:00:00.000Z',
        },
      };
    }
    if (method === 'POST' && path === '/v1/conversions') {
      const request = body as {
        url?: string;
        uploadId?: string;
        to: string;
        maxCredits?: number;
      };
      const key = headers['Idempotency-Key'];
      const replay = key ? this.keys.get(key) : undefined;
      if (replay) return { status: 200, body: this.view(this.conversions.get(replay)!) };
      let conversion: FakeConversion;
      if (request.url) {
        conversion = this.create({ url: request.url, name: nameOfLink(request.url) }, request);
      } else {
        const upload = this.uploads.get(request.uploadId ?? '');
        if (!upload || upload.received < upload.size)
          return error(404, 'notFound', 'There is no upload with this id.');
        conversion = this.create({ url: null, name: upload.name }, request);
        conversion.from = extensionFormat(upload.name);
        this.price_(conversion);
      }
      if (key) this.keys.set(key, conversion.id);
      return { status: 201, body: this.view(conversion) };
    }
    const status = /^\/v1\/conversions\/([^/]+)$/.exec(path);
    if (method === 'GET' && status) {
      const conversion = this.conversions.get(status[1]!);
      if (!conversion) return error(404, 'notFound', 'There is no conversion with this id.');
      this.advance(conversion);
      return { status: 200, body: this.view(conversion) };
    }
    const confirm = /^\/v1\/conversions\/([^/]+)\/confirm$/.exec(path);
    if (method === 'POST' && confirm) {
      const conversion = this.conversions.get(confirm[1]!);
      if (!conversion) return error(404, 'notFound', 'There is no conversion with this id.');
      if (conversion.status === 'quoted') {
        conversion.status = 'processing';
        this.credits -= conversion.credits ?? 0;
      }
      return { status: 200, body: this.view(conversion) };
    }
    return error(404, 'notFound', 'Not found.');
  }

  /** The file the browser sent to an upload link (`fetch` stand-in). */
  receive(url: string, init: RequestInit): Response {
    const id = /\/v1\/uploads\/([^/?]+)/.exec(url)?.[1] ?? '';
    const upload = this.uploads.get(id);
    if (!upload)
      return new Response(JSON.stringify({ error: { code: 'notFound', message: 'No upload.' } }), {
        status: 404,
      });
    upload.received += (init.body as Blob).size;
    return new Response(JSON.stringify({ id, received: upload.received }), { status: 200 });
  }

  private create(
    source: { url: string | null; name: string | null },
    request: { to: string; maxCredits?: number },
  ): FakeConversion {
    const conversion: FakeConversion = {
      id: `cv${this.next++}`,
      status: source.url ? 'fetching' : 'queued',
      url: source.url,
      name: source.name,
      from: null,
      to: request.to,
      maxCredits: request.maxCredits ?? 20,
      credits: null,
      progress: null,
      error: null,
      polls: 0,
    };
    this.conversions.set(conversion.id, conversion);
    return conversion;
  }

  /** Priced: on its way within `maxCredits`, otherwise waiting for `confirm`. */
  private price_(conversion: FakeConversion) {
    conversion.credits = this.price;
    if (this.price > conversion.maxCredits) conversion.status = 'quoted';
    else {
      conversion.status = 'queued';
      this.credits -= this.price;
    }
  }

  private advance(conversion: FakeConversion) {
    if (conversion.status === 'fetching') {
      if (this.linkFailure) {
        conversion.status = 'failed';
        conversion.error = this.linkFailure;
        return;
      }
      conversion.from = this.linkFrom(conversion.url!);
      this.price_(conversion);
      return;
    }
    if (conversion.status === 'queued') {
      conversion.status = 'processing';
      conversion.progress = 0;
      return;
    }
    if (conversion.status === 'processing') {
      conversion.polls += 1;
      conversion.progress = 50;
      if (conversion.polls < this.processingPolls) return;
      if (this.conversionFailure) {
        conversion.status = 'failed';
        conversion.error = this.conversionFailure;
        return;
      }
      conversion.status = 'done';
      conversion.progress = 100;
    }
  }

  private view(c: FakeConversion): Conversion {
    const done = c.status === 'done';
    const base = (c.name ?? 'file').replace(/\.[^.]+$/, '');
    return {
      id: c.id,
      status: c.status,
      from: c.from,
      to: c.to,
      inputName: c.name,
      credits: c.credits,
      progress: c.progress,
      outputName: done ? `${base}.${c.to}` : null,
      outputSize: done ? 64_000 : null,
      downloadUrl: done ? `${BASE}/jobs/${c.id}/download?token=d_${c.id}` : null,
      expiresAt: done ? '2026-11-23T22:00:00.000Z' : null,
      error: c.error,
    };
  }
}

export function error(status: number, code: string, message: string, params = {}): ApiAnswer {
  return { status, body: { error: { code, message, params } } };
}

/** A Zendesk attachment link's file name (`?name=`), or its last path segment. */
function nameOfLink(url: string): string {
  const parsed = new URL(url);
  return parsed.searchParams.get('name') ?? parsed.pathname.split('/').filter(Boolean).pop() ?? '';
}

function extensionFormat(name: string | null): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(name ?? '')?.[1]?.toLowerCase();
  if (!extension) return null;
  return FORMATS.find((f) => f.extensions.includes(extension))?.id ?? null;
}
