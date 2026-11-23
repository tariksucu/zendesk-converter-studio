import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/App';
import { KEY } from './fake-api';
import { FakeZaf, attachment } from './fake-zaf';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function ticket(zaf = new FakeZaf()) {
  zaf.pages = [
    [
      {
        id: 2,
        public: false,
        attachments: [attachment(20, 'contract.docx', { size: 48_000 })],
      },
      {
        id: 1,
        attachments: [
          attachment(10, 'IMG_1234.HEIC', { content_type: 'image/heic' }),
          attachment(11, 'setup.exe'),
          attachment(12, 'virus.pdf', { malware_scan_result: 'malware_found' }),
        ],
      },
    ],
  ];
  return zaf;
}

async function open(zaf: FakeZaf) {
  render(<App client={zaf} />);
  return screen.findByRole('region', { name: 'IMG_1234.HEIC' });
}

describe('the ticket sidebar', () => {
  it('lists the attachments it can convert, with what each can become', async () => {
    const zaf = ticket();
    const card = await open(zaf);
    expect(screen.getByText('4 attachments')).toBeTruthy();
    expect(within(card).getByText('2.1 MB · HEIC')).toBeTruthy();
    const select = within(card).getByLabelText<HTMLSelectElement>('Convert to');
    expect(select.value).toBe('jpg');
    expect(Array.from(select.options).map((o) => o.textContent)).toContain('PNG');
    const docx = screen.getByRole('region', { name: 'contract.docx' });
    expect(within(docx).getByText('48 KB · DOCX · internal note')).toBeTruthy();
    expect(
      screen.getByText(
        'Not converted here: setup.exe, virus.pdf (flagged by Zendesk’s malware scan).',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/120 credits left/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Plans and credits/ }).getAttribute('href')).toBe(
      'https://converter.studio/pricing',
    );
    expect(screen.getByRole('link', { name: /Privacy/ }).getAttribute('href')).toBe(
      'https://converter.studio/privacy',
    );
  });

  it('converts an attachment by its link and offers the result', async () => {
    const zaf = ticket();
    const card = await open(zaf);
    fireEvent.change(within(card).getByLabelText('Convert to'), { target: { value: 'png' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Convert' }));
    const download = await within(card).findByRole('link', { name: 'Download' }, { timeout: 4000 });
    expect(download.getAttribute('href')).toMatch(
      /^https:\/\/converter\.studio\/api\/jobs\/cv\d+\/download\?token=/,
    );
    expect(download.getAttribute('target')).toBe('_blank');
    const view = within(card).getByRole('link', { name: /Open/ });
    expect(view.getAttribute('href')).toMatch(/&inline=1$/);
    expect(within(card).getByText('IMG_1234.png')).toBeTruthy();
    expect(within(card).getByText(/The link works for 6 hours/)).toBeTruthy();
    expect(screen.getByText(/119 credits left/)).toBeTruthy();
    // The attachment's link went to the API, through the proxy, with the key filled in there.
    const create = zaf.api.calls.find((c) => c.path === '/v1/conversions')!;
    expect(create.body).toMatchObject({
      url: 'https://example.zendesk.com/attachments/token/tok10/?name=IMG_1234.HEIC',
      to: 'png',
      maxCredits: 0,
    });
    expect(create.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(zaf.requests)).not.toContain(KEY);
  }, 10_000);

  it('asks an admin for a working key', async () => {
    const zaf = ticket();
    zaf.apiKey = 'cvs_live_revoked';
    render(<App client={zaf} />);
    expect(await screen.findByText('Connect Converter Studio')).toBeTruthy();
    expect(screen.getByText(/Admin Center/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /Converter Studio account page/ }).getAttribute('href'),
    ).toBe('https://converter.studio/account#api-keys');
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('offers to try again when Converter Studio cannot be reached', async () => {
    const zaf = ticket();
    zaf.api.override = { status: 503, body: '<html>busy</html>' };
    render(<App client={zaf} />);
    expect(await screen.findByText('Converter Studio answered 503. Try again later.')).toBeTruthy();
    zaf.api.override = null;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'IMG_1234.HEIC' })).toBeTruthy();
  });

  it('lets the agent choose the saved file when attachments need a sign-in', async () => {
    const zaf = ticket();
    zaf.privateAttachments = true;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url, init) =>
        Promise.resolve(zaf.api.receive(String(url as string), init!)),
      );
    try {
      const card = await open(zaf);
      expect(screen.getByText(/asks for a sign-in to open attachments/)).toBeTruthy();
      const convert = within(card).getByRole('button', { name: 'Convert' });
      expect((convert as HTMLButtonElement).disabled).toBe(true);
      expect(
        within(card)
          .getByRole('link', { name: /open the attachment/ })
          .getAttribute('href'),
      ).toBe('https://example.zendesk.com/attachments/token/tok10/?name=IMG_1234.HEIC');
      const input = card.querySelector<HTMLInputElement>('input[type=file]')!;
      expect(input.accept).toBe('.heic,.heif');
      const file = new File(['heic bytes'], 'IMG_1234.HEIC');
      fireEvent.change(input, { target: { files: [file] } });
      expect(within(card).getByText(/IMG_1234\.HEIC · 10 B/)).toBeTruthy();
      fireEvent.click(convert);
      await within(card).findByRole('link', { name: 'Download' }, { timeout: 4000 });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(zaf.api.calls.find((c) => c.path === '/v1/conversions')!.body).toMatchObject({
        maxCredits: 10,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  }, 10_000);

  it('switches to choosing the file when Zendesk sends a sign-in page', async () => {
    const zaf = ticket();
    zaf.api.linkFrom = () => 'html';
    const card = await open(zaf);
    fireEvent.click(within(card).getByRole('button', { name: 'Convert' }));
    expect(
      await within(card).findByText(
        /asks for a sign-in to open attachments/,
        {},
        { timeout: 4000 },
      ),
    ).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Choose the saved file' })).toBeTruthy();
    expect(zaf.api.calls.some((c) => c.path.endsWith('/confirm'))).toBe(false);
  }, 10_000);

  it('explains a refused price and that nothing was charged', async () => {
    const zaf = ticket();
    zaf.settings = { maxCredits: 2 };
    zaf.api.price = 5;
    const card = await open(zaf);
    fireEvent.click(within(card).getByRole('button', { name: 'Convert' }));
    expect(
      await within(card).findByText(
        /would use 5 credits.*up to 2.*Nothing was charged/,
        {},
        { timeout: 4000 },
      ),
    ).toBeTruthy();
  }, 10_000);

  it('says when a ticket has no attachments', async () => {
    const zaf = new FakeZaf();
    render(<App client={zaf} />);
    expect(await screen.findByText('No attachments')).toBeTruthy();
    expect(screen.getByText(/show up here/)).toBeTruthy();
  });

  it('asks for a saved ticket on a new one', async () => {
    const zaf = new FakeZaf();
    zaf.ticket = null;
    render(<App client={zaf} />);
    expect(await screen.findByText('Open a saved ticket to see its attachments.')).toBeTruthy();
  });

  it('says where it works when opened outside Zendesk', () => {
    render(<App client={null} />);
    expect(screen.getByText('Open this app from a ticket in Zendesk.')).toBeTruthy();
  });

  it('follows the agent’s light or dark mode', async () => {
    const zaf = ticket();
    await open(zaf);
    /** Every CSS rule styled-components wrote (Garden's components follow the theme). */
    const rules = () =>
      Array.from(document.styleSheets)
        .flatMap((sheet) => Array.from(sheet.cssRules).map((rule) => rule.cssText))
        .join('\n');
    // Garden's dark background (#151a1e) as jsdom writes it.
    const DARK = /#151a1e|rgb\(21, 26, 30\)/;
    await waitFor(() => expect(zaf.handlers.get('colorScheme.changed')).toHaveLength(1));
    expect(rules()).not.toMatch(DARK);
    act(() => zaf.trigger('colorScheme.changed', 'dark'));
    await waitFor(() => expect(rules()).toMatch(DARK));
  });
});
