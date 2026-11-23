import { describe, expect, it } from 'vitest';
import { ConverterApi } from '../src/api';
import { Catalog, formatBytes, loadCatalog, viewUrl } from '../src/catalog';
import { readSettings } from '../src/settings';
import { BASE, FORMATS, FakeApi } from './fake-api';
import { FakeZaf } from './fake-zaf';

const catalog = new Catalog(FORMATS);

describe('formats of attachments', () => {
  it('finds a format by extension, in any case, two-part ones too', () => {
    expect(catalog.formatOf({ name: 'IMG_1234.HEIC' })?.id).toBe('heic');
    expect(catalog.formatOf({ name: 'clip.mkv' })?.id).toBe('mkv');
    expect(catalog.formatOf({ name: 'photo.jpeg' })?.id).toBe('jpg');
    expect(catalog.formatOf({ name: 'logs.tar.gz' })?.id).toBe('tgz');
  });

  it('falls back on the content type', () => {
    expect(catalog.formatOf({ name: 'image', contentType: 'image/heic' })?.id).toBe('heic');
    expect(catalog.formatOf({ name: 'clip', contentType: 'video/quicktime' })?.id).toBe('mov');
    expect(
      catalog.formatOf({
        name: 'report',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document; charset=binary',
      })?.id,
    ).toBe('docx');
    expect(catalog.formatOf({ name: 'x.unknownext', contentType: '' })).toBeUndefined();
    expect(
      catalog.formatOf({ name: 'setup.exe', contentType: 'application/x-msdownload' }),
    ).toBeUndefined();
  });

  it('offers what the server lists, labelled', () => {
    const heic = catalog.targets(catalog.get('heic'));
    expect(heic[0]).toEqual({ key: 'jpg', to: 'jpg', label: 'JPG', options: {} });
    expect(heic.find((t) => t.to === 'txt')?.label).toMatch(/text from the picture/);
    const pdf = catalog.targets(catalog.get('pdf'));
    expect(pdf.find((t) => t.to === 'pdf')).toEqual({
      key: 'pdf',
      to: 'pdf',
      label: 'PDF (smaller file)',
      options: { compression: 'balanced' },
    });
    expect(catalog.targets(catalog.get('mkv')).map((t) => t.to)).toContain('mp4');
    expect(catalog.targets(undefined)).toEqual([]);
  });

  it('offers “Open” only for results a browser shows', () => {
    const link = 'https://converter.studio/api/jobs/1/download?token=t';
    expect(viewUrl(link, 'jpg', 'a.jpg')).toBe(`${link}&inline=1`);
    expect(viewUrl(link, 'mp4', 'a.mp4')).toBe(`${link}&inline=1`);
    expect(viewUrl(link, 'docx', 'a.docx')).toBeNull();
    expect(viewUrl(link, 'png', 'pages.zip')).toBeNull();
    expect(viewUrl('https://x.test/f', 'pdf', 'a.pdf')).toBe('https://x.test/f?inline=1');
  });

  it('writes sizes the short way', () => {
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(64_000)).toBe('64 KB');
    expect(formatBytes(2_100_000)).toBe('2.1 MB');
    expect(formatBytes(3_000_000)).toBe('3 MB');
  });
});

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

describe('the format list cache', () => {
  function setup() {
    const fake = new FakeApi();
    const api = new ConverterApi(new FakeZaf(fake), BASE);
    return { fake, api, storage: new MemoryStorage() as unknown as Storage };
  }

  it('asks the API once, then reads the browser’s copy for six hours', async () => {
    const { fake, api, storage } = setup();
    await loadCatalog(api, storage, 1_000);
    await loadCatalog(api, storage, 1_000 + 5 * 3600_000);
    expect(fake.calls).toHaveLength(1);
    await loadCatalog(api, storage, 1_000 + 7 * 3600_000);
    expect(fake.calls).toHaveLength(2);
  });

  it('does not use a copy from another API address or a broken one', async () => {
    const { fake, api, storage } = setup();
    storage.setItem(
      'converter-studio:formats',
      JSON.stringify({ base: 'https://other.example/api', at: 1, formats: FORMATS }),
    );
    await loadCatalog(api, storage, 2);
    storage.setItem('converter-studio:formats', '{not json');
    await loadCatalog(api, storage, 3);
    expect(fake.calls).toHaveLength(2);
  });

  it('works without storage, or with storage that refuses', async () => {
    const { api } = setup();
    expect((await loadCatalog(api, null)).get('heic')).toBeDefined();
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect((await loadCatalog(api, refusing)).get('pdf')).toBeDefined();
  });
});

describe('settings', () => {
  it('reads the credit limit, 10 by default, 1 to 1000', () => {
    expect(readSettings({}).maxCredits).toBe(10);
    expect(readSettings(undefined).maxCredits).toBe(10);
    expect(readSettings({ maxCredits: 25 }).maxCredits).toBe(25);
    expect(readSettings({ maxCredits: '7' }).maxCredits).toBe(7);
    expect(readSettings({ maxCredits: '' }).maxCredits).toBe(10);
    expect(readSettings({ maxCredits: 'lots' }).maxCredits).toBe(10);
    expect(readSettings({ maxCredits: 0 }).maxCredits).toBe(1);
    expect(readSettings({ maxCredits: 2.9 }).maxCredits).toBe(2);
    expect(readSettings({ maxCredits: 1e9 }).maxCredits).toBe(1000);
  });

  it('reads the hidden API address, converter.studio unless it is a plain http(s) URL', () => {
    expect(readSettings({}).baseUrl).toBe(BASE);
    expect(readSettings({ baseUrl: 'http://127.0.0.1:9630/' }).baseUrl).toBe(
      'http://127.0.0.1:9630',
    );
    expect(readSettings({ baseUrl: 'ftp://x.test' }).baseUrl).toBe(BASE);
    expect(readSettings({ baseUrl: 'https://u:p@x.test' }).baseUrl).toBe(BASE);
    expect(readSettings({ baseUrl: 'https://x.test/api?a=1' }).baseUrl).toBe(BASE);
    expect(readSettings({ baseUrl: 'not a url' }).baseUrl).toBe(BASE);
  });
});
