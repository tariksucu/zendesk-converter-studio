import type { ZafClient, ZafMetadata, ZafRequestOptions, ZafResponse } from '../src/zaf';
import { FakeApi, KEY } from './fake-api';

/**
 * The Zendesk Apps Framework client, for the unit tests. It plays the three parts the app talks
 * to through `client.request`:
 *
 * - **the Zendesk API** (`/api/v2/…`, the agent's session): `zendesk` answers by path;
 * - **Zendesk's proxy** (any other URL): it fills in `{{setting.apiKey}}` the way Zendesk
 *   documents it, only for a `secure` request to a host in the manifest's `domainWhitelist`, and
 *   only in a header (the setting's `scopes`), then asks the fake Converter Studio API;
 * - **the framework**: `get`, `metadata`, `invoke` and `on`.
 *
 * Like the real client, a request that does not answer 2xx rejects with the response.
 */

export interface Comment {
  readonly id: number;
  readonly public?: boolean;
  readonly created_at?: string;
  readonly attachments: readonly Record<string, unknown>[];
}

export class FakeZaf implements ZafClient {
  readonly requests: ZafRequestOptions[] = [];
  readonly invoked: { name: string; args: unknown[] }[] = [];
  readonly handlers = new Map<string, ((data?: unknown) => void)[]>();
  settings: Record<string, unknown> = { maxCredits: 10 };
  ticket: number | null = 42;
  colorScheme: 'light' | 'dark' = 'light';
  /** The ticket's comments, one page per inner list. */
  pages: Comment[][] = [[]];
  /** The account's `tickets.private_attachments`, or an error status. */
  privateAttachments: boolean | number = false;
  /** The secure setting's value as the admin entered it. */
  apiKey = KEY;

  constructor(
    readonly api: FakeApi = new FakeApi(),
    readonly domainWhitelist: readonly string[] = ['converter.studio'],
  ) {}

  async request<T = unknown>(input: ZafRequestOptions | string): Promise<T> {
    const options: ZafRequestOptions = typeof input === 'string' ? { url: input } : input;
    this.requests.push(options);
    if (options.url.startsWith('/')) return this.zendesk(options) as T;
    if (options.cors) throw new Error('This app never makes CORS requests through ZAF.');
    const url = new URL(options.url);
    const allowed = options.secure === true && this.domainWhitelist.includes(url.hostname);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.headers ?? {}))
      headers[name] = allowed ? value.replaceAll('{{setting.apiKey}}', this.apiKey) : value;
    if (options.data?.includes('{{setting.')) throw new Error('A setting in a body: not scoped.');
    const answer = this.api.handle(options.type ?? 'GET', url, headers, options.data);
    const response: ZafResponse = {
      status: answer.status,
      statusText: answer.status < 400 ? 'success' : 'error',
      responseJSON: answer.body,
      responseText: JSON.stringify(answer.body),
      headers: {},
    };
    if (answer.status < 200 || answer.status >= 300) throw response;
    return (options.httpCompleteResponse ? response : answer.body) as T;
  }

  async get(path: string | readonly string[]): Promise<Record<string, unknown>> {
    const paths = typeof path === 'string' ? [path] : path;
    const answer: Record<string, unknown> = {};
    for (const p of paths) {
      if (p === 'ticket.id') answer[p] = this.ticket;
      else if (p === 'colorScheme') answer[p] = this.colorScheme;
    }
    return answer;
  }

  async invoke(name: string, ...args: unknown[]): Promise<unknown> {
    this.invoked.push({ name, args });
    return {};
  }

  async metadata(): Promise<ZafMetadata> {
    return { appId: 0, installationId: 1, settings: this.settings };
  }

  on(event: string, handler: (data?: unknown) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  trigger(event: string, data?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }

  private zendesk(options: ZafRequestOptions): unknown {
    const url = new URL(options.url, 'https://example.zendesk.com');
    if (url.pathname === '/api/v2/account/settings.json') {
      if (typeof this.privateAttachments === 'number')
        throw { status: this.privateAttachments, responseText: '{"error":"Forbidden"}' };
      return { settings: { tickets: { private_attachments: this.privateAttachments } } };
    }
    const comments = /^\/api\/v2\/tickets\/(\d+)\/comments\.json$/.exec(url.pathname);
    if (comments && Number(comments[1]) === this.ticket) {
      const page = Number(url.searchParams.get('page[after]') ?? 0);
      const hasMore = page + 1 < this.pages.length;
      return {
        comments: this.pages[page] ?? [],
        meta: { has_more: hasMore, after_cursor: hasMore ? String(page + 1) : null },
        links: {
          next: hasMore
            ? `https://example.zendesk.com${url.pathname}?page%5Bafter%5D=${page + 1}&page%5Bsize%5D=100`
            : null,
        },
      };
    }
    throw { status: 404, responseText: '{"error":"RecordNotFound"}' };
  }
}

/** One attachment as the List Comments API gives it. */
export function attachment(
  id: number,
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    file_name: name,
    content_url: `https://example.zendesk.com/attachments/token/tok${id}/?name=${encodeURIComponent(name)}`,
    mapped_content_url: `https://example.zendesk.com/attachments/token/tok${id}/?name=${encodeURIComponent(name)}`,
    content_type: 'application/octet-stream',
    size: 2_100_000,
    inline: false,
    deleted: false,
    malware_scan_result: 'malware_not_found',
    malware_access_override: false,
    thumbnails: [],
    ...extra,
  };
}
