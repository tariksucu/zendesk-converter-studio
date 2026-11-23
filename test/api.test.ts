import { describe, expect, it, vi } from 'vitest';
import { ApiError, CLIENT_HEADER, ConverterApi, errorOf, KEY_PLACEHOLDER } from '../src/api';
import { VERSION } from '../src/version';
import { BASE, FakeApi, KEY, error } from './fake-api';
import { FakeZaf } from './fake-zaf';
import pkg from '../package.json';

function setup() {
  const api = new FakeApi();
  const zaf = new FakeZaf(api);
  const fetchFn = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve(api.receive(url, init!)),
  );
  return { api, zaf, client: new ConverterApi(zaf, BASE, fetchFn), fetchFn };
}

describe('requests through Zendesk’s proxy', () => {
  it('names the app with its package version', () => {
    expect(VERSION).toBe(pkg.version);
    expect(CLIENT_HEADER).toEqual({ 'X-Converter-Studio-Client': `zendesk/${pkg.version}` });
  });

  it('asks the proxy to put the secure setting in the Authorization header', async () => {
    const { zaf, api, client } = setup();
    const formats = await client.formats();
    expect(formats.length).toBeGreaterThan(50);
    const sent = zaf.requests[0]!;
    expect(sent).toMatchObject({
      url: `${BASE}/v1/formats`,
      type: 'GET',
      secure: true,
      cors: false,
      dataType: 'json',
      httpCompleteResponse: true,
    });
    // The app itself only ever holds the placeholder.
    expect(sent.headers!.Authorization).toBe(`Bearer ${KEY_PLACEHOLDER}`);
    expect(JSON.stringify(zaf.requests)).not.toContain(KEY);
    // What reached the API: the real key and the client header.
    expect(api.calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(api.calls[0]!.headers['X-Converter-Studio-Client']).toBe(`zendesk/${pkg.version}`);
  });

  it('sends JSON bodies and the idempotency key on conversions', async () => {
    const { zaf, api, client } = setup();
    await client.convert(
      {
        url: 'https://example.zendesk.com/attachments/token/a/?name=a.heic',
        to: 'jpg',
        maxCredits: 0,
      },
      'zendesk-key-1',
    );
    const sent = zaf.requests[0]!;
    expect(sent.type).toBe('POST');
    expect(sent.contentType).toBe('application/json');
    expect(JSON.parse(sent.data!)).toEqual({
      url: 'https://example.zendesk.com/attachments/token/a/?name=a.heic',
      to: 'jpg',
      maxCredits: 0,
    });
    expect(api.calls[0]!.headers['Idempotency-Key']).toBe('zendesk-key-1');
  });

  it('waits on the server for a status, at most 20 seconds', async () => {
    const { zaf, client } = setup();
    await expect(client.status('cv1', 12)).rejects.toMatchObject({ code: 'notFound' });
    await expect(client.status('cv1', 90)).rejects.toThrow();
    expect(zaf.requests.map((r) => r.url)).toEqual([
      `${BASE}/v1/conversions/cv1?wait=12`,
      `${BASE}/v1/conversions/cv1?wait=20`,
    ]);
  });

  it('sends a confirmation as an empty JSON body', async () => {
    const { zaf, client } = setup();
    await client.confirm('x').catch(() => undefined);
    expect(zaf.requests[0]).toMatchObject({
      type: 'POST',
      data: '{}',
      contentType: 'application/json',
    });
  });

  it('never sends the key when Zendesk would not fill it in (another host)', async () => {
    const api = new FakeApi();
    const zaf = new FakeZaf(api);
    const client = new ConverterApi(zaf, 'https://evil.example/api');
    await expect(client.account()).rejects.toMatchObject({ code: 'invalidApiKey', status: 401 });
    expect(api.calls[0]!.headers.Authorization).toBe(`Bearer ${KEY_PLACEHOLDER}`);
  });

  it('trims the base URL', () => {
    expect(new ConverterApi(new FakeZaf(), 'https://converter.studio/api///').base).toBe(BASE);
  });
});

describe('errors', () => {
  it('shows the API’s own message', async () => {
    const { api, client } = setup();
    api.override = error(402, 'notEnoughCredits', 'You need 3 credits; you have 1.', { needed: 3 });
    await expect(client.account()).rejects.toMatchObject({
      code: 'notEnoughCredits',
      message: 'You need 3 credits; you have 1.',
      status: 402,
      params: { needed: 3 },
    });
  });

  it('tells where to fix a key that does not work, without the key', async () => {
    const { zaf, client } = setup();
    zaf.apiKey = 'cvs_live_wrong';
    const failure = await client.account().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('invalidApiKey');
    expect((failure as ApiError).message).toMatch(/Admin Center/);
    expect((failure as ApiError).message).not.toContain('cvs_live');
  });

  it('reads a body that came as text only, and answers without one', () => {
    expect(
      errorOf({
        status: 429,
        responseText: '{"error":{"code":"tooManyRequests","message":"Slow down."}}',
      }),
    ).toMatchObject({ code: 'tooManyRequests', message: 'Slow down.' });
    expect(errorOf({ status: 503, responseText: '<html>Bad gateway</html>' })).toMatchObject({
      code: 'http503',
      message: 'Converter Studio answered 503. Try again later.',
    });
    expect(errorOf({ status: 401 })).toMatchObject({ code: 'invalidApiKey' });
    expect(errorOf({ status: 410, responseJSON: { error: 'fileExpired' } })).toMatchObject({
      code: 'fileExpired',
      message: 'The converted file has expired. Convert it again.',
    });
  });

  it('calls a request with no status a network failure', () => {
    expect(errorOf({ status: 0, statusText: 'timeout' }).code).toBe('network');
    expect(errorOf(undefined).code).toBe('network');
    expect(errorOf(new Error('boom')).code).toBe('network');
  });

  it('refuses an answer it cannot read', async () => {
    const zaf = new FakeZaf();
    zaf.request = (() => Promise.resolve({ status: 200, responseText: 'not json' })) as never;
    await expect(new ConverterApi(zaf, BASE).formats()).rejects.toMatchObject({
      code: 'badResponse',
    });
  });
});

describe('uploads from the browser', () => {
  it('sends a small file in one request, without cookies or the key', async () => {
    const { client, fetchFn } = setup();
    const upload = await client.createUpload('photo.heic', 5);
    const progress: number[] = [];
    await client.upload(upload, new Blob(['12345']), { onProgress: (n) => progress.push(n) });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(upload.uploadUrl);
    expect(init).toMatchObject({ method: 'PUT', credentials: 'omit' });
    expect(init!.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
    expect(progress).toEqual([5]);
  });

  it('sends a big file in parts with their offsets', async () => {
    const { api, client, fetchFn } = setup();
    const upload = await client.createUpload('video.mkv', 10);
    await client.upload(upload, new Blob(['0123456789']), { partBytes: 4 });
    expect(
      fetchFn.mock.calls.map(
        ([, init]) => (init!.headers as Record<string, string>)['Upload-Offset'],
      ),
    ).toEqual(['0', '4', '8']);
    expect(api.uploads.get(upload.id)!.received).toBe(10);
  });

  it('goes on from what the server has after a broken part, once', async () => {
    const { client, fetchFn, api } = setup();
    const upload = await client.createUpload('video.mkv', 10);
    let broken = false;
    fetchFn.mockImplementation((url, init) => {
      const offset = (init!.headers as Record<string, string>)['Upload-Offset'];
      if (offset === '4' && !broken) {
        broken = true;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 'uploadIncomplete', message: 'Part cut.', params: { received: 4 } },
            }),
            { status: 409 },
          ),
        );
      }
      return Promise.resolve(api.receive(url, init!));
    });
    await client.upload(upload, new Blob(['0123456789']), { partBytes: 4 });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('says plainly when the browser may not send the file (CORS or offline)', async () => {
    const { client, fetchFn } = setup();
    const upload = await client.createUpload('a.heic', 3);
    fetchFn.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(client.upload(upload, new Blob(['abc']))).rejects.toMatchObject({
      code: 'uploadBlocked',
    });
  });

  it('sends files only to the API’s own links', async () => {
    const { client, fetchFn } = setup();
    await expect(
      client.upload(
        { id: 'x', uploadUrl: 'https://evil.example/v1/uploads/x', maxBytes: 9, partBytes: 9 },
        new Blob(['a']),
      ),
    ).rejects.toMatchObject({ code: 'invalidRequest' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(() => client.ownLink(`${BASE}/jobs/1/download?token=t`)).not.toThrow();
    expect(() => client.ownLink('https://converter.studio/apix/jobs/1')).toThrow();
  });
});
