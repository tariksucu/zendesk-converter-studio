import { describe, expect, it } from 'vitest';
import { listAttachments, requiresSignIn, ticketId } from '../src/zendesk';
import { FakeZaf, attachment } from './fake-zaf';

describe('the ticket’s attachments', () => {
  it('reads every page of comments, newest first, inline images included', async () => {
    const zaf = new FakeZaf();
    zaf.pages = [
      [
        {
          id: 3,
          public: false,
          created_at: '2026-11-23T10:00:00Z',
          attachments: [attachment(30, 'scan.pdf', { content_type: 'application/pdf', size: 900 })],
        },
        { id: 2, attachments: [] },
      ],
      [{ id: 1, attachments: [attachment(10, 'IMG_1234.HEIC', { inline: true })] }],
    ];
    const list = await listAttachments(zaf, 42);
    expect(list.map((a) => [a.id, a.name, a.commentId, a.isPublic, a.inline])).toEqual([
      [30, 'scan.pdf', 3, false, false],
      [10, 'IMG_1234.HEIC', 1, true, true],
    ]);
    expect(list[0]).toMatchObject({
      url: 'https://example.zendesk.com/attachments/token/tok30/?name=scan.pdf',
      contentType: 'application/pdf',
      size: 900,
      createdAt: '2026-11-23T10:00:00Z',
      blocked: false,
    });
    // Asked with the agent's session (a path, not a URL), newest first, inline images too.
    const first = zaf.requests[0]!;
    expect(first.url).toBe(
      '/api/v2/tickets/42/comments.json?include_inline_images=true&sort=-created_at&page%5Bsize%5D=100',
    );
    expect(first.secure).toBeUndefined();
    expect(zaf.requests[1]!.url).toBe(
      '/api/v2/tickets/42/comments.json?page%5Bafter%5D=1&page%5Bsize%5D=100',
    );
  });

  it('leaves out redacted files and links that are not web links; marks malware', async () => {
    const zaf = new FakeZaf();
    zaf.pages = [
      [
        {
          id: 1,
          attachments: [
            attachment(1, 'gone.png', { deleted: true }),
            attachment(2, 'odd.png', { content_url: 'javascript:alert(1)' }),
            attachment(3, 'bad.exe', { malware_scan_result: 'malware_found' }),
            attachment(4, 'ok.exe', {
              malware_scan_result: 'malware_found',
              malware_access_override: true,
            }),
            attachment(5, '', {}),
          ],
        },
      ],
    ];
    const list = await listAttachments(zaf, 42);
    expect(list.map((a) => [a.id, a.name, a.blocked])).toEqual([
      [3, 'bad.exe', true],
      [4, 'ok.exe', false],
      [5, 'file-5', false],
    ]);
  });

  it('stops after ten pages', async () => {
    const zaf = new FakeZaf();
    zaf.pages = Array.from({ length: 12 }, (_, i) => [
      { id: i, attachments: [attachment(i, `f${i}.png`)] },
    ]);
    expect(await listAttachments(zaf, 42)).toHaveLength(10);
  });

  it('says it is Zendesk when its API refuses the comments', async () => {
    const zaf = new FakeZaf();
    zaf.ticket = 7;
    await expect(listAttachments(zaf, 42)).rejects.toMatchObject({
      code: 'zendeskError',
      status: 404,
      message: "Zendesk did not list this ticket's attachments (HTTP 404). Try again in a moment.",
    });
  });

  it('reads the ticket id', async () => {
    const zaf = new FakeZaf();
    expect(await ticketId(zaf)).toBe(42);
    zaf.ticket = null;
    expect(await ticketId(zaf)).toBeNull();
  });
});

describe('whether attachments need a sign-in', () => {
  it('reads the account setting', async () => {
    const zaf = new FakeZaf();
    expect(await requiresSignIn(zaf)).toBe(false);
    zaf.privateAttachments = true;
    expect(await requiresSignIn(zaf)).toBe(true);
    expect(zaf.requests.at(-1)!.url).toBe('/api/v2/account/settings.json');
  });

  it('is unknown when the setting cannot be read', async () => {
    const zaf = new FakeZaf();
    zaf.privateAttachments = 403;
    expect(await requiresSignIn(zaf)).toBeNull();
  });
});
