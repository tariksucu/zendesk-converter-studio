/**
 * The part of the Zendesk Apps Framework (ZAF) client this app uses. The client itself is
 * Zendesk's SDK, loaded by `iframe.html` from Zendesk's CDN (`window.ZAFClient`); these types
 * only describe it, so the app's code can be tested with a stand-in (test/fake-zaf.ts).
 *
 * Reference: https://developer.zendesk.com/api-reference/apps/apps-core-api/client_api/
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/** `client.request(options)`: a subset of its options. */
export interface ZafRequestOptions {
  readonly url: string;
  readonly type?: HttpMethod;
  readonly headers?: Readonly<Record<string, string>>;
  /** A string only: the SDK sends the options to Zendesk as JSON (no binary data). */
  readonly data?: string;
  readonly contentType?: string | false;
  readonly dataType?: 'json' | 'text';
  /**
   * false (the default): a request to a non-Zendesk URL goes through Zendesk's proxy server,
   * which fills in secure settings (`{{setting.name}}`). Requests to the Zendesk API always go
   * from the browser with the agent's session.
   */
  readonly cors?: boolean;
  /** Lets the proxy fill in secure settings. */
  readonly secure?: boolean;
  readonly timeout?: number;
  /** Resolve with `{ status, responseJSON, responseText, headers }` instead of the body. */
  readonly httpCompleteResponse?: boolean;
  readonly autoRetry?: boolean;
}

/** What a request resolves with (`httpCompleteResponse`), or rejects with when it fails. */
export interface ZafResponse {
  readonly status: number;
  readonly statusText?: string;
  readonly responseJSON?: unknown;
  readonly responseText?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** `client.metadata()`: the installation and its settings (secure settings are never in it). */
export interface ZafMetadata {
  readonly appId: number;
  readonly installationId: number;
  readonly version?: string;
  readonly settings: Readonly<Record<string, unknown>>;
}

export interface ZafClient {
  request<T = unknown>(options: ZafRequestOptions | string): Promise<T>;
  get(path: string | readonly string[]): Promise<Record<string, unknown>>;
  invoke(name: string, ...args: unknown[]): Promise<unknown>;
  metadata(): Promise<ZafMetadata>;
  on(event: string, handler: (data?: unknown) => void): void;
}

declare global {
  interface Window {
    ZAFClient?: { init(): ZafClient | undefined | false };
  }
}

/** The client of the page Zendesk opened this app in, or null outside Zendesk. */
export function initClient(): ZafClient | null {
  const client = window.ZAFClient?.init();
  return client ? client : null;
}
