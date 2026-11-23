/**
 * A small client for the Converter Studio REST API (https://converter.studio/developers), made
 * for a Zendesk app.
 *
 * The API key never reaches the agent's browser. It is a *secure setting* of the app: every
 * request that needs it goes through Zendesk's proxy server (`client.request` with
 * `secure: true`), which puts the key in place of `{{setting.apiKey}}`, and only in a header of a
 * request to converter.studio (the manifest's `domainWhitelist` and the setting's `scopes`). The
 * key is also what the API counts its rate limits by, so even the format list carries it.
 *
 * Zendesk's proxy carries text only (its SDK sends a request's options as JSON). So the one
 * binary transfer the app ever makes, a file the agent chooses on their computer, goes from the
 * browser straight to its upload link, which carries its own one-time token and no key.
 */

import { VERSION } from './version';
import type { ZafClient, ZafRequestOptions, ZafResponse } from './zaf';

export const CLIENT_NAME = 'zendesk';
/** Names this app, with its version, on its API calls (Converter Studio's connector counts). */
export const CLIENT_HEADER = { 'X-Converter-Studio-Client': `${CLIENT_NAME}/${VERSION}` } as const;
export const DEFAULT_BASE = 'https://converter.studio/api';
/** Zendesk's proxy replaces this with the secure setting `apiKey` (manifest.json). */
export const KEY_PLACEHOLDER = '{{setting.apiKey}}';

/** What the API says when something goes wrong: `{ error: { code, message, params } }`. */
export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

/** A failed request. `code` is the API's error code, or one of this app's own (`network`…). */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly params: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface FormatInfo {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly extensions: readonly string[];
  /** What it converts to on the server right now, most used first. */
  readonly to: readonly string[];
}

export interface Account {
  readonly plan: string;
  readonly credits: number;
  readonly maxFileBytes: number;
}

export interface Upload {
  readonly id: string;
  readonly uploadUrl: string;
  readonly maxBytes: number;
  readonly partBytes: number;
}

export type ConversionStatus =
  | 'fetching'
  | 'waiting_for_upload'
  | 'measuring'
  | 'quoted'
  | 'queued'
  | 'processing'
  | 'done'
  | 'failed'
  | 'expired'
  | 'canceled';

export interface Conversion {
  readonly id: string;
  readonly status: ConversionStatus;
  readonly from: string | null;
  readonly to: string | null;
  readonly inputName: string | null;
  readonly credits: number | null;
  readonly progress: number | null;
  readonly outputName: string | null;
  readonly outputSize: number | null;
  readonly downloadUrl: string | null;
  readonly expiresAt: string | null;
  readonly error: ApiErrorBody | null;
}

export type ConversionOptions = Readonly<Record<string, string | number | boolean>>;

/** A link's file (`url`) or an upload's (`uploadId`), to `to`. */
export type ConvertRequest = (
  | { readonly url: string; readonly uploadId?: never }
  | { readonly uploadId: string; readonly url?: never }
) & {
  readonly to: string;
  readonly options?: ConversionOptions;
  /** Goes ahead on its own up to this price; 0 only prices it (it waits for `confirm`). */
  readonly maxCredits: number;
};

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** How long one proxied request may take; Zendesk's proxy gives up on longer ones. */
const REQUEST_TIMEOUT_MS = 28_000;

export class ConverterApi {
  readonly base: string;

  /** `base`: the API's root, e.g. `https://converter.studio/api`. */
  constructor(
    private readonly client: ZafClient,
    base: string = DEFAULT_BASE,
    private readonly fetchFn: Fetch = (input, init) => fetch(input, init),
  ) {
    this.base = base.replace(/\/+$/, '');
  }

  /** The formats and what each becomes on the server now. */
  formats(): Promise<FormatInfo[]> {
    return this.call<{ formats: FormatInfo[] }>('GET', '/v1/formats').then((r) => r.formats);
  }

  /** The key's account: also how the app finds out that the key works. */
  account(): Promise<Account> {
    return this.call('GET', '/v1/account');
  }

  createUpload(fileName: string, size: number): Promise<Upload> {
    return this.call('POST', '/v1/uploads', { fileName, size });
  }

  /**
   * Sends a file to its upload link from the browser: in one request when it is small, otherwise
   * in parts (`Upload-Offset`), which also gives progress and lets a broken part be sent again
   * once. Needs the API to allow this app's origin (CORS); without it the browser refuses.
   */
  async upload(
    upload: Upload,
    file: Blob,
    options: { partBytes?: number; onProgress?: (sent: number) => void; signal?: AbortSignal } = {},
  ): Promise<void> {
    this.ownLink(upload.uploadUrl);
    const partBytes = Math.min(options.partBytes ?? 8 * 1024 * 1024, upload.partBytes);
    if (file.size <= partBytes) {
      await this.put(upload.uploadUrl, file, {}, options.signal);
      options.onProgress?.(file.size);
      return;
    }
    let offset = 0;
    let retried = false;
    while (offset < file.size) {
      const end = Math.min(offset + partBytes, file.size);
      try {
        await this.put(
          upload.uploadUrl,
          file.slice(offset, end),
          { 'Upload-Offset': String(offset) },
          options.signal,
        );
      } catch (error) {
        // A part the server did not get whole: go on from what it has, once.
        if (!retried && error instanceof ApiError && typeof error.params.received === 'number') {
          retried = true;
          offset = error.params.received;
          continue;
        }
        throw error;
      }
      offset = end;
      options.onProgress?.(offset);
    }
  }

  /**
   * Starts a conversion. `idempotencyKey`: the same key sent again (after a lost answer) gives
   * the same conversion, never a second one or a second charge.
   */
  convert(request: ConvertRequest, idempotencyKey: string): Promise<Conversion> {
    return this.call('POST', '/v1/conversions', request, { 'Idempotency-Key': idempotencyKey });
  }

  /** The conversion now, or (with `waitSeconds`) once it settles or that time has passed. */
  status(id: string, waitSeconds = 0): Promise<Conversion> {
    const wait = waitSeconds > 0 ? `?wait=${Math.min(20, Math.round(waitSeconds))}` : '';
    return this.call('GET', `/v1/conversions/${encodeURIComponent(id)}${wait}`);
  }

  confirm(id: string): Promise<Conversion> {
    return this.call('POST', `/v1/conversions/${encodeURIComponent(id)}/confirm`, {});
  }

  /** Links the API gave out must point back at it: a file never goes anywhere else. */
  ownLink(url: string): void {
    if (!url.startsWith(`${this.base}/`))
      throw new ApiError('invalidRequest', 'The link is not on Converter Studio.', 0);
  }

  /** The options of one proxied request (exported for the tests through `requestOptions`). */
  requestOptions(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extra: Readonly<Record<string, string>> = {},
  ): ZafRequestOptions {
    return {
      url: `${this.base}${path}`,
      type: method,
      headers: {
        ...CLIENT_HEADER,
        Authorization: `Bearer ${KEY_PLACEHOLDER}`,
        Accept: 'application/json',
        ...extra,
      },
      secure: true,
      cors: false,
      dataType: 'json',
      httpCompleteResponse: true,
      timeout: REQUEST_TIMEOUT_MS,
      ...(body === undefined
        ? {}
        : { contentType: 'application/json', data: JSON.stringify(body) }),
    };
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extra: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    let response: ZafResponse;
    try {
      response = await this.client.request<ZafResponse>(
        this.requestOptions(method, path, body, extra),
      );
    } catch (failure) {
      throw errorOf(failure);
    }
    if (typeof response?.status !== 'number' || response.status < 200 || response.status >= 300)
      throw errorOf(response);
    const json = jsonOf(response);
    if (json === undefined)
      throw new ApiError('badResponse', 'Converter Studio sent an answer the app cannot read.', 0);
    return json as T;
  }

  private async put(
    url: string,
    body: Blob,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', ...headers },
        body,
        signal,
        credentials: 'omit',
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      // A network failure, or the browser's CORS check (the API does not list this app's page).
      throw new ApiError(
        'uploadBlocked',
        'The file could not be sent to Converter Studio from this browser.',
        0,
      );
    }
    if (!response.ok) {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // Not JSON (a proxy's error page).
      }
      throw errorOf({ status: response.status, responseJSON: body });
    }
  }
}

export function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** The body of a proxied answer: `responseJSON`, or `responseText` read as JSON. */
function jsonOf(response: Partial<ZafResponse> | undefined): unknown {
  if (!response) return undefined;
  if (response.responseJSON !== undefined && response.responseJSON !== null)
    return response.responseJSON;
  if (typeof response.responseText === 'string' && response.responseText) {
    try {
      return JSON.parse(response.responseText) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * An error from a failed request: the API's own message when it sent one (never anything about
 * the key itself, which the app never sees), otherwise one by the status.
 */
export function errorOf(failure: unknown): ApiError {
  if (failure instanceof ApiError) return failure;
  const response = (typeof failure === 'object' && failure !== null ? failure : {}) as Partial<
    ZafResponse & { status: unknown }
  >;
  const status = typeof response.status === 'number' ? response.status : 0;
  const body = jsonOf(response) as { error?: ApiErrorBody | string } | undefined;
  const error = body?.error;
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    if (error.code === 'invalidApiKey')
      return new ApiError(error.code, MESSAGES.invalidApiKey!, status, error.params ?? {});
    return new ApiError(error.code, error.message, status, error.params ?? {});
  }
  if (status === 0)
    return new ApiError(
      'network',
      'Converter Studio could not be reached. Check your connection and try again.',
      0,
    );
  const code =
    typeof error === 'string' ? error : status === 401 ? 'invalidApiKey' : `http${status}`;
  return new ApiError(
    code,
    MESSAGES[code] ?? `Converter Studio answered ${status}. Try again later.`,
    status,
  );
}

const MESSAGES: Readonly<Record<string, string>> = {
  invalidApiKey:
    'The Converter Studio API key in this app’s settings does not work. An admin can enter a new one in Admin Center, under Apps and integrations › Zendesk Support apps › Converter Studio.',
  fileExpired: 'The converted file has expired. Convert it again.',
  notFound: 'Converter Studio could not find this conversion.',
  tooManyRequests: 'Too many requests. Wait a minute and try again.',
  serverBusy: 'Converter Studio is busy right now. Try again in a few minutes.',
};
