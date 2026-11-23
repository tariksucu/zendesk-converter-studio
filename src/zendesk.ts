/**
 * What the app reads from Zendesk, through the ZAF client with the agent's own session (requests
 * to the Zendesk API always go from the browser): the ticket's attachments and whether the
 * account requires a sign-in to open attachments. The app never writes to the ticket.
 *
 * - List Comments: https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_comments/
 * - Attachments: https://developer.zendesk.com/api-reference/ticketing/tickets/ticket-attachments/
 * - Account settings: https://developer.zendesk.com/api-reference/ticketing/account-configuration/account_settings/
 */

import { ApiError } from './api';
import type { ZafClient } from './zaf';

/** One attachment of one of the ticket's comments. */
export interface TicketAttachment {
  readonly id: number;
  readonly commentId: number;
  readonly name: string;
  /** Where Zendesk serves the file (`content_url`). */
  readonly url: string;
  readonly contentType: string;
  readonly size: number;
  /** Shown inside the comment's text rather than in its attachment list. */
  readonly inline: boolean;
  /** Public reply or internal note. */
  readonly isPublic: boolean;
  readonly createdAt: string;
  /** Zendesk's malware scan found something and the account does not let it be downloaded. */
  readonly blocked: boolean;
}

interface RawAttachment {
  readonly id?: unknown;
  readonly file_name?: unknown;
  readonly content_url?: unknown;
  readonly content_type?: unknown;
  readonly size?: unknown;
  readonly inline?: unknown;
  readonly deleted?: unknown;
  readonly malware_scan_result?: unknown;
  readonly malware_access_override?: unknown;
}

interface RawComment {
  readonly id?: unknown;
  readonly public?: unknown;
  readonly created_at?: unknown;
  readonly attachments?: readonly RawAttachment[];
}

interface CommentsPage {
  readonly comments?: readonly RawComment[];
  readonly meta?: { readonly has_more?: boolean };
  readonly links?: { readonly next?: string | null };
}

/** Pages of 100 comments; a ticket with more than this many pages shows its newest only. */
const MAX_PAGES = 10;

/** The ticket open in the sidebar. */
export async function ticketId(client: ZafClient): Promise<number | null> {
  const answer = await client.get('ticket.id');
  const id = answer['ticket.id'];
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Every attachment of the ticket, newest comment first; deleted (redacted) ones left out. */
export async function listAttachments(
  client: ZafClient,
  ticket: number,
): Promise<TicketAttachment[]> {
  const attachments: TicketAttachment[] = [];
  let url: string | null =
    `/api/v2/tickets/${ticket}/comments.json?include_inline_images=true&sort=-created_at&page%5Bsize%5D=100`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    let answer: CommentsPage;
    try {
      answer = await client.request<CommentsPage>({ url, type: 'GET', dataType: 'json' });
    } catch (failure) {
      throw zendeskError(failure);
    }
    for (const comment of answer.comments ?? []) attachments.push(...attachmentsOf(comment));
    url = answer.meta?.has_more ? pathOf(answer.links?.next) : null;
  }
  return attachments;
}

function attachmentsOf(comment: RawComment): TicketAttachment[] {
  const commentId = typeof comment.id === 'number' ? comment.id : 0;
  const createdAt = typeof comment.created_at === 'string' ? comment.created_at : '';
  const list: TicketAttachment[] = [];
  for (const raw of comment.attachments ?? []) {
    if (raw.deleted === true) continue;
    if (typeof raw.id !== 'number' || typeof raw.content_url !== 'string') continue;
    if (!/^https?:\/\//i.test(raw.content_url)) continue;
    list.push({
      id: raw.id,
      commentId,
      name: typeof raw.file_name === 'string' && raw.file_name ? raw.file_name : `file-${raw.id}`,
      url: raw.content_url,
      contentType: typeof raw.content_type === 'string' ? raw.content_type : '',
      size: typeof raw.size === 'number' ? raw.size : 0,
      inline: raw.inline === true,
      isPublic: comment.public !== false,
      createdAt,
      blocked: raw.malware_scan_result === 'malware_found' && raw.malware_access_override !== true,
    });
  }
  return list;
}

/** Zendesk's own API refused (a role without access to the ticket, an outage): say it is Zendesk. */
function zendeskError(failure: unknown): ApiError {
  const status =
    typeof failure === 'object' && failure !== null && 'status' in failure
      ? Number(failure.status) || 0
      : 0;
  return new ApiError(
    'zendeskError',
    `Zendesk did not list this ticket's attachments${status ? ` (HTTP ${status})` : ''}. Try again in a moment.`,
    status,
  );
}

/** The next page's link as a path on the agent's own Zendesk (the client adds the domain). */
function pathOf(next: string | null | undefined): string | null {
  if (!next) return null;
  try {
    const url = new URL(next, 'https://zendesk.invalid');
    return url.pathname.startsWith('/api/v2/') ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

/**
 * Whether the account makes people sign in to open attachments ("private attachments"). Then
 * an attachment's link does not work for Converter Studio's server, and the agent chooses the
 * file instead. `null` when it cannot be read (the app then tries the link and finds out).
 */
export async function requiresSignIn(client: ZafClient): Promise<boolean | null> {
  try {
    const answer = await client.request<{
      settings?: { tickets?: { private_attachments?: unknown } };
    }>({ url: '/api/v2/account/settings.json', type: 'GET', dataType: 'json' });
    const value = answer.settings?.tickets?.private_attachments;
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}
