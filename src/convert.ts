import {
  ApiError,
  type Conversion,
  type ConversionOptions,
  type ConversionStatus,
  type ConverterApi,
  type ConvertRequest,
} from './api';

/**
 * One conversion from start to finish, in one of two ways:
 *
 * - **A ticket attachment's link** (`convertLink`): Converter Studio's server downloads the file
 *   from Zendesk itself; nothing passes through the agent's browser. The conversion is asked for
 *   with `maxCredits: 0`, so it stops at its price, uncharged: the app first checks that the file
 *   that arrived is the attachment (an account that requires a sign-in for attachments answers
 *   with its sign-in page instead) and that the price is within the app's limit, then confirms.
 * - **A file the agent chose** (`convertFile`), for accounts whose attachment links need a
 *   sign-in: the browser sends it to an upload link, then it converts on its own up to the limit.
 *
 * Either way a conversion priced above the limit (the admin's setting) is never charged.
 */

/** How long one status request waits on the server; well under Zendesk's proxy timeout. */
export const WAIT_SECONDS = 12;
/** How long one conversion is followed before the app gives up. */
export const TIMEOUT_MS = 30 * 60_000;

/** What a link's file must not turn out to be when the attachment was something else. */
const WEB_PAGES: ReadonlySet<string> = new Set(['html', 'xml']);

export type Step =
  | { readonly step: 'uploading'; readonly sent: number; readonly total: number }
  | {
      readonly step: 'converting';
      readonly status: ConversionStatus;
      readonly progress: number | null;
    };

export interface Hooks {
  readonly onStep?: (step: Step) => void;
  /** Checked between requests: the agent pressed Cancel. */
  readonly canceled?: () => boolean;
  readonly signal?: AbortSignal;
  /** Tests make time pass faster. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly idempotencyKey?: () => string;
}

export interface Result {
  readonly conversionId: string;
  readonly to: string;
  readonly downloadUrl: string;
  readonly outputName: string;
  readonly size: number;
  readonly credits: number;
  readonly expiresAt: string | null;
}

export interface LinkJob {
  /** The attachment's `content_url`. */
  readonly url: string;
  /** The attachment's format (the API's id), by its name. */
  readonly expected: string;
  readonly to: string;
  readonly options: ConversionOptions;
}

export interface FileJob {
  readonly file: Blob;
  /** The file's name: the server reads the format from it and its bytes. */
  readonly name: string;
  readonly to: string;
  readonly options: ConversionOptions;
}

/** Zendesk did not hand the attachment to Converter Studio: its links need a sign-in. */
export class SignInRequired extends ApiError {
  constructor() {
    super(
      'signInRequired',
      'Converter Studio could not fetch this attachment from Zendesk: your Zendesk asks for a sign-in to open attachments. Nothing was charged. Save the file from the ticket, then choose it here.',
      0,
    );
    this.name = 'SignInRequired';
  }
}

export async function convertLink(
  api: ConverterApi,
  job: LinkJob,
  limit: number,
  hooks: Hooks = {},
): Promise<Result> {
  hooks.onStep?.({ step: 'converting', status: 'fetching', progress: null });
  const request: ConvertRequest = {
    url: job.url,
    to: job.to,
    options: job.options,
    maxCredits: 0,
  };
  let conversion: Conversion;
  try {
    conversion = await start(api, request, hooks);
  } catch (error) {
    // The server checks the link before it fetches anything.
    if (error instanceof ApiError && error.code === 'invalidUrl') throw new SignInRequired();
    throw error;
  }
  try {
    return await follow(api, conversion, { limit, expected: job.expected, to: job.to }, hooks);
  } catch (error) {
    throw linkError(error, job.expected);
  }
}

export async function convertFile(
  api: ConverterApi,
  job: FileJob,
  limit: number,
  hooks: Hooks = {},
): Promise<Result> {
  hooks.onStep?.({ step: 'uploading', sent: 0, total: job.file.size });
  const upload = await api.createUpload(job.name, job.file.size);
  await api.upload(upload, job.file, {
    signal: hooks.signal,
    onProgress: (sent) => hooks.onStep?.({ step: 'uploading', sent, total: job.file.size }),
  });
  if (hooks.canceled?.()) throw canceled();
  const conversion = await start(
    api,
    { uploadId: upload.id, to: job.to, options: job.options, maxCredits: limit },
    hooks,
  );
  return follow(api, conversion, { limit, to: job.to }, hooks);
}

/** Asks for the conversion; a lost answer is asked again with the same key (one conversion). */
async function start(
  api: ConverterApi,
  request: ConvertRequest,
  hooks: Hooks,
): Promise<Conversion> {
  const key = (hooks.idempotencyKey ?? newIdempotencyKey)();
  try {
    return await api.convert(request, key);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'network') throw error;
    await (hooks.sleep ?? delay)(2000);
    return api.convert(request, key);
  }
}

async function follow(
  api: ConverterApi,
  first: Conversion,
  rule: { readonly limit: number; readonly expected?: string; readonly to: string },
  hooks: Hooks,
): Promise<Result> {
  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? delay;
  const deadline = now() + TIMEOUT_MS;
  let conversion = first;
  let confirmed = false;
  let failures = 0;
  for (;;) {
    hooks.onStep?.({
      step: 'converting',
      status: conversion.status,
      progress: conversion.progress,
    });
    if (conversion.status === 'quoted' && !confirmed) {
      if (rule.expected && notTheAttachment(conversion.from, rule.expected))
        throw new SignInRequired();
      const credits = conversion.credits ?? 0;
      if (credits > rule.limit) throw overLimit(credits, rule.limit);
      if (hooks.canceled?.()) throw canceled();
      conversion = await api.confirm(conversion.id);
      confirmed = true;
      continue;
    }
    if (settled(conversion.status)) break;
    if (hooks.canceled?.()) throw canceled();
    if (now() > deadline)
      throw new ApiError(
        'timeout',
        'The conversion is taking too long. Try again later, or with a smaller file.',
        0,
      );
    try {
      conversion = await api.status(conversion.id, WAIT_SECONDS);
      failures = 0;
    } catch (error) {
      // A dropped connection while waiting: wait longer each time, then give up.
      if (error instanceof ApiError && error.code === 'network' && failures < 4) {
        await sleep(2000 * 2 ** failures);
        failures += 1;
        continue;
      }
      throw error;
    }
  }

  if (conversion.status !== 'done' || !conversion.downloadUrl) {
    const error = conversion.error;
    if (error) throw new ApiError(error.code, error.message, 0, error.params ?? {});
    throw new ApiError(
      conversion.status,
      conversion.status === 'expired'
        ? 'The result expired before it could be used. Convert the file again.'
        : 'The conversion did not finish. No credits were charged for it.',
      0,
    );
  }
  api.ownLink(conversion.downloadUrl);
  return {
    conversionId: conversion.id,
    to: conversion.to ?? rule.to,
    downloadUrl: conversion.downloadUrl,
    outputName: conversion.outputName ?? 'converted',
    size: conversion.outputSize ?? 0,
    credits: conversion.credits ?? 0,
    expiresAt: conversion.expiresAt,
  };
}

/** The file that arrived is a web page (a sign-in page), not the attachment. */
function notTheAttachment(from: string | null, expected: string): boolean {
  if (from === expected || WEB_PAGES.has(expected)) return false;
  return from === null || WEB_PAGES.has(from);
}

/**
 * A link conversion that failed because the file never came: Zendesk refused it (401/403/404),
 * or sent a page the server cannot read as the attachment.
 */
function linkError(error: unknown, expected: string): unknown {
  if (!(error instanceof ApiError) || error instanceof SignInRequired) return error;
  if (error.code === 'remoteNotFound') return new SignInRequired();
  if (error.code === 'unsupportedConversion') {
    const from = typeof error.params.from === 'string' ? error.params.from : null;
    if (from === 'unknown' || notTheAttachment(from, expected)) return new SignInRequired();
  }
  return error;
}

function overLimit(credits: number, limit: number): ApiError {
  return new ApiError(
    'overLimit',
    `Converting this file would use ${credits} credits. This app may use up to ${limit} for one conversion (a Zendesk admin can change that in the app’s settings). Nothing was charged.`,
    0,
    { credits, limit },
  );
}

const canceled = () => new ApiError('canceled', 'Canceled. Nothing was charged.', 0);

const settled = (status: ConversionStatus) =>
  status === 'done' || status === 'failed' || status === 'expired' || status === 'canceled';

/** A fresh key for one conversion request, so a repeated request does not convert twice. */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return `zendesk-${crypto.randomUUID()}`;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `zendesk-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
