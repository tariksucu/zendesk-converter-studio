import { describe, expect, it, vi } from 'vitest';
import { ApiError, ConverterApi } from '../src/api';
import {
  SignInRequired,
  TIMEOUT_MS,
  convertFile,
  convertLink,
  newIdempotencyKey,
  type Step,
} from '../src/convert';
import { BASE, FakeApi } from './fake-api';
import { FakeZaf } from './fake-zaf';

const LINK = 'https://example.zendesk.com/attachments/token/tok1/?name=IMG_1234.HEIC';

function setup() {
  const fake = new FakeApi();
  const zaf = new FakeZaf(fake);
  const fetchFn = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve(fake.receive(url, init!)),
  );
  const api = new ConverterApi(zaf, BASE, fetchFn);
  const steps: Step[] = [];
  const hooks = { onStep: (s: Step) => steps.push(s), sleep: () => Promise.resolve() };
  return { fake, zaf, api, steps, hooks, fetchFn };
}

const job = { url: LINK, expected: 'heic', to: 'jpg', options: {} };

describe('converting an attachment by its link', () => {
  it('prices it first, checks the file, confirms within the limit, and gives the result', async () => {
    const { fake, api, steps, hooks } = setup();
    const result = await convertLink(api, job, 10, hooks);
    expect(result).toMatchObject({
      to: 'jpg',
      outputName: 'IMG_1234.jpg',
      credits: 1,
      size: 64_000,
      expiresAt: '2026-11-23T22:00:00.000Z',
    });
    expect(result.downloadUrl).toMatch(/^https:\/\/converter\.studio\/api\/jobs\//);
    // Asked to stop at the price: nothing charged before the app said yes.
    const create = fake.calls.find((c) => c.path === '/v1/conversions')!;
    expect(create.body).toEqual({ url: LINK, to: 'jpg', options: {}, maxCredits: 0 });
    expect(create.headers['Idempotency-Key']).toMatch(/^zendesk-/);
    expect(fake.calls.some((c) => c.path.endsWith('/confirm'))).toBe(true);
    expect(fake.calls.filter((c) => c.path.includes('?wait=12')).length).toBeGreaterThan(0);
    expect(steps.map((s) => (s.step === 'converting' ? s.status : s.step))).toEqual([
      'fetching',
      'fetching',
      'quoted',
      'processing',
      'done',
    ]);
    expect(fake.credits).toBe(119);
  });

  it('stops, uncharged, when Zendesk sent a sign-in page instead of the file', async () => {
    const { fake, api, hooks } = setup();
    fake.linkFrom = () => 'html';
    const failure = await convertLink(api, job, 10, hooks).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SignInRequired);
    expect((failure as ApiError).message).toMatch(/sign-in/);
    expect(fake.calls.some((c) => c.path.endsWith('/confirm'))).toBe(false);
    expect(fake.credits).toBe(120);
  });

  it('takes an HTML attachment for what it is', async () => {
    const { fake, api, hooks } = setup();
    fake.linkFrom = () => 'html';
    const result = await convertLink(
      api,
      {
        url: 'https://example.zendesk.com/attachments/token/t/?name=page.html',
        expected: 'html',
        to: 'pdf',
        options: {},
      },
      10,
      hooks,
    );
    expect(result.to).toBe('pdf');
  });

  it('converts a file whose bytes are another real format than its name says', async () => {
    const { fake, api, hooks } = setup();
    fake.linkFrom = () => 'jpg';
    await expect(convertLink(api, job, 10, hooks)).resolves.toMatchObject({ to: 'jpg' });
  });

  it('calls a refused link a sign-in problem', async () => {
    const { fake, api, hooks } = setup();
    fake.linkFailure = { code: 'remoteNotFound', message: 'The link could not be opened.' };
    await expect(convertLink(api, job, 10, hooks)).rejects.toBeInstanceOf(SignInRequired);
  });

  it('calls an unreadable page a sign-in problem, but not other unsupported conversions', async () => {
    const { fake, api, hooks } = setup();
    fake.linkFailure = {
      code: 'unsupportedConversion',
      message: 'Converting unknown to JPG is not supported.',
      params: { from: 'unknown', to: 'jpg' },
    };
    await expect(convertLink(api, job, 10, hooks)).rejects.toBeInstanceOf(SignInRequired);
    fake.linkFailure = {
      code: 'unsupportedConversion',
      message: 'Converting MKV to JPG is not supported.',
      params: { from: 'mkv', to: 'jpg' },
    };
    await expect(convertLink(api, job, 10, hooks)).rejects.toMatchObject({
      code: 'unsupportedConversion',
      message: 'Converting MKV to JPG is not supported.',
    });
  });

  it('refuses a price above the limit, uncharged', async () => {
    const { fake, api, hooks } = setup();
    fake.price = 12;
    await expect(convertLink(api, job, 10, hooks)).rejects.toMatchObject({
      code: 'overLimit',
      params: { credits: 12, limit: 10 },
      message: expect.stringMatching(/12 credits.*up to 10.*Nothing was charged/) as string,
    });
    expect(fake.credits).toBe(120);
  });

  it('asks again with the same key when the first answer was lost', async () => {
    const { fake, zaf, api, hooks } = setup();
    const request = zaf.request.bind(zaf);
    let dropped = false;
    zaf.request = (async (options: never) => {
      const answer = await request(options);
      const url = (options as { url: string }).url;
      if (!dropped && url.endsWith('/v1/conversions')) {
        dropped = true;
        throw { status: 0, statusText: 'error' };
      }
      return answer;
    }) as never;
    await convertLink(api, job, 10, hooks);
    const creates = fake.calls.filter((c) => c.path === '/v1/conversions');
    expect(creates).toHaveLength(2);
    expect(creates[0]!.headers['Idempotency-Key']).toBe(creates[1]!.headers['Idempotency-Key']);
    expect(fake.conversions.size).toBe(1);
  });

  it('rides out dropped status requests, then gives up', async () => {
    const { fake, zaf, api, hooks } = setup();
    const request = zaf.request.bind(zaf);
    let drops = 2;
    zaf.request = (async (options: never) => {
      const url = (options as { url: string }).url;
      if (url.includes('?wait=') && drops-- > 0) throw { status: 0 };
      return request(options);
    }) as never;
    await expect(convertLink(api, job, 10, hooks)).resolves.toBeDefined();
    drops = 99;
    await expect(convertLink(api, job, 10, hooks)).rejects.toMatchObject({ code: 'network' });
    expect(fake.conversions.size).toBe(2);
  });

  it('shows a conversion’s own failure', async () => {
    const { fake, api, hooks } = setup();
    fake.conversionFailure = { code: 'conversionFailed', message: 'The file is damaged.' };
    await expect(convertLink(api, job, 10, hooks)).rejects.toMatchObject({
      code: 'conversionFailed',
      message: 'The file is damaged.',
    });
  });

  it('gives up after half an hour', async () => {
    const { fake, api, hooks } = setup();
    fake.processingPolls = 1e9;
    let clock = 0;
    const failure = convertLink(api, job, 10, {
      ...hooks,
      now: () => (clock += TIMEOUT_MS / 5),
    });
    await expect(failure).rejects.toMatchObject({ code: 'timeout' });
  });

  it('stops before paying when canceled', async () => {
    const { fake, api, hooks } = setup();
    let canceled = false;
    const failure = convertLink(api, job, 10, {
      ...hooks,
      onStep: (s) => {
        if (s.step === 'converting' && s.status === 'quoted') canceled = true;
      },
      canceled: () => canceled,
    });
    await expect(failure).rejects.toMatchObject({ code: 'canceled' });
    expect(fake.calls.some((c) => c.path.endsWith('/confirm'))).toBe(false);
  });

  it('turns a link the API refuses into the sign-in advice', async () => {
    const { fake, api, hooks } = setup();
    fake.override = { status: 400, body: { error: { code: 'invalidUrl', message: 'Bad link.' } } };
    await expect(convertLink(api, job, 10, hooks)).rejects.toBeInstanceOf(SignInRequired);
  });
});

describe('converting a file the agent chose', () => {
  it('uploads it from the browser, then converts within the limit on its own', async () => {
    const { fake, api, steps, hooks, fetchFn } = setup();
    const file = new Blob(['heic bytes']);
    const result = await convertFile(
      api,
      { file, name: 'IMG_1234.HEIC', to: 'jpg', options: {} },
      10,
      hooks,
    );
    expect(result.outputName).toBe('IMG_1234.jpg');
    expect(fetchFn).toHaveBeenCalledOnce();
    const create = fake.calls.find((c) => c.path === '/v1/conversions')!;
    expect(create.body).toMatchObject({ to: 'jpg', maxCredits: 10 });
    expect((create.body as { uploadId: string }).uploadId).toMatch(/^up/);
    expect(fake.calls.some((c) => c.path.endsWith('/confirm'))).toBe(false);
    expect(steps[0]).toEqual({ step: 'uploading', sent: 0, total: 10 });
    expect(steps).toContainEqual({ step: 'uploading', sent: 10, total: 10 });
  });

  it('refuses a price above the limit, uncharged', async () => {
    const { fake, api, hooks } = setup();
    fake.price = 50;
    await expect(
      convertFile(
        api,
        { file: new Blob(['x']), name: 'long.mkv', to: 'mp4', options: {} },
        10,
        hooks,
      ),
    ).rejects.toMatchObject({ code: 'overLimit' });
    expect(fake.credits).toBe(120);
  });

  it('reports a browser that may not send the file', async () => {
    const { api, hooks, fetchFn } = setup();
    fetchFn.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      convertFile(
        api,
        { file: new Blob(['x']), name: 'a.heic', to: 'jpg', options: {} },
        10,
        hooks,
      ),
    ).rejects.toMatchObject({ code: 'uploadBlocked' });
  });
});

it('makes a fresh, recognisable idempotency key each time', () => {
  const a = newIdempotencyKey();
  expect(a).toMatch(/^zendesk-[0-9a-f-]{32,36}$/);
  expect(newIdempotencyKey()).not.toBe(a);
});
