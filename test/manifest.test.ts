import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BASE, KEY_PLACEHOLDER } from '../src/api';
import { DEFAULT_MAX_CREDITS } from '../src/settings';

/**
 * The manifest and the Marketplace texts against Zendesk's published rules (Marketplace "Create
 * content" and "Create brand assets", the manifest reference, and the checks of
 * zendesk_apps_support, the library Zendesk validates uploads with).
 */

const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'src/manifest.json'), 'utf8')) as {
  name: string;
  author: { name: string; email: string; url: string };
  defaultLocale: string;
  private: boolean;
  location: { support: { ticket_sidebar: { url: string; flexible: boolean } } };
  frameworkVersion: string;
  domainWhitelist: string[];
  parameters: {
    name: string;
    type: string;
    required: boolean;
    secure?: boolean;
    default?: unknown;
    scopes?: string[];
  }[];
};
const en = JSON.parse(readFileSync(join(root, 'src/translations/en.json'), 'utf8')) as {
  app: {
    name: string;
    short_description: string;
    long_description: string;
    installation_instructions: string;
    parameters: Record<string, { label: string; helpText?: string }>;
  };
};

describe('manifest.json', () => {
  it('is a public ticket sidebar app on framework 2', () => {
    expect(manifest.private).toBe(false);
    expect(manifest.frameworkVersion).toBe('2.0');
    expect(manifest.defaultLocale).toBe('en');
    expect(manifest.location.support.ticket_sidebar).toEqual({
      url: 'assets/iframe.html',
      flexible: true,
    });
    expect(Object.keys(manifest.location)).toEqual(['support']);
  });

  it('names Converter Studio as the author, with its site and support address', () => {
    expect(manifest.author).toEqual({
      name: 'Converter Studio',
      email: 'support@converter.studio',
      url: 'https://converter.studio',
    });
  });

  it('keeps the API key a secure setting, header only, for converter.studio only', () => {
    const key = manifest.parameters.find((p) => p.name === 'apiKey')!;
    expect(key).toEqual({
      name: 'apiKey',
      type: 'text',
      required: true,
      secure: true,
      scopes: ['header'],
    });
    expect(KEY_PLACEHOLDER).toBe('{{setting.apiKey}}');
    expect(manifest.domainWhitelist).toEqual([new URL(DEFAULT_BASE).hostname]);
  });

  it('has the settings the app reads, with defaults where Zendesk allows them', () => {
    expect(manifest.parameters.map((p) => [p.name, p.type])).toEqual([
      ['apiKey', 'text'],
      ['maxCredits', 'number'],
      ['baseUrl', 'hidden'],
    ]);
    const types = ['text', 'checkbox', 'url', 'number', 'multiline', 'hidden', 'oauth'];
    for (const p of manifest.parameters) {
      expect(types).toContain(p.type);
      // Zendesk warns about defaults on secure or hidden settings; hidden ones cannot be required.
      if (p.secure || p.type === 'hidden') expect(p.default).toBeUndefined();
      if (p.type === 'hidden') expect(p.required).toBe(false);
      // A name with key/token/password must be secure (zendesk_apps_support's warning).
      if (/token|key|pwd|password/i.test(p.name)) expect(p.secure).toBe(true);
    }
    expect(manifest.parameters.find((p) => p.name === 'maxCredits')!.default).toBe(
      DEFAULT_MAX_CREDITS,
    );
  });

  it('matches package.json’s version (the build writes it in)', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect((manifest as unknown as { version: string }).version).toBe(pkg.version);
  });
});

describe('the Marketplace texts (translations/en.json)', () => {
  it('names the app by the product only, within 40 characters', () => {
    expect(en.app.name).toBe('Converter Studio');
    expect(manifest.name).toBe(en.app.name);
    expect(en.app.name.length).toBeLessThanOrEqual(40);
    expect(en.app.name).not.toMatch(/zendesk/i);
  });

  it('has a short description of at most 80 characters', () => {
    expect(en.app.short_description.length).toBeLessThanOrEqual(80);
    expect(en.app.short_description).toBe(
      'Convert ticket attachments: HEIC to JPG, MOV to MP4, DOCX to PDF and more',
    );
  });

  it('has a long description with the company, the function and a data disclosure', () => {
    const text = en.app.long_description;
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).toMatch(/\*\*About Converter Studio\*\*/);
    expect(text).toMatch(/\*\*How it works\*\*/);
    expect(text).toMatch(/\*\*Your data\*\*/);
    expect(text).toContain('(https://converter.studio/privacy)');
    expect(text).toContain('(https://converter.studio/pricing)');
    expect(text).toContain('(https://converter.studio)');
  });

  it('has installation instructions as numbered steps', () => {
    const text = en.app.installation_instructions;
    expect(text.length).toBeLessThanOrEqual(10_000);
    expect(text).toMatch(/^1\. /);
    expect(text).toContain('(https://converter.studio/account#api-keys)');
  });

  it('labels every setting', () => {
    for (const p of manifest.parameters) expect(en.app.parameters[p.name]?.label).toBeTruthy();
  });

  it('only claims conversions the API offers', async () => {
    const { formats } = (await import('./fixtures/formats.json')) as {
      formats: { id: string; to: string[] }[];
    };
    const offers = (from: string, to: string) =>
      formats.find((f) => f.id === from)?.to.includes(to) ?? false;
    for (const [from, to] of [
      ['heic', 'jpg'],
      ['mkv', 'mp4'],
      ['docx', 'pdf'],
      ['mov', 'mp4'],
      ['avi', 'mp4'],
      ['xlsx', 'pdf'],
      ['pptx', 'pdf'],
      ['pdf', 'docx'],
      ['pdf', 'pdf'],
      ['png', 'txt'],
    ])
      expect(offers(from!, to!), `${from} → ${to}`).toBe(true);
  });

  it('avoids words Zendesk’s secret scanner warns about', () => {
    // zendesk_apps_support's Secrets check looks for these words in every text file.
    const words = /password|secret|api_key|auth_key|authKey|secretToken|auth_pass|auth_user/;
    for (const file of ['src/manifest.json', 'src/translations/en.json', 'src/iframe.html'])
      expect(readFileSync(join(root, file), 'utf8'), file).not.toMatch(words);
  });
});

describe('brand assets', () => {
  /** A PNG's width, height and colour type (6: true colour with alpha). */
  function png(name: string) {
    const bytes = readFileSync(join(root, 'src/assets', name));
    expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), type: bytes[25] };
  }

  it('has the logos Zendesk asks for', () => {
    expect(png('logo.png')).toMatchObject({ width: 320, height: 320 });
    expect(png('logo-small.png')).toEqual({ width: 128, height: 128, type: 6 });
  });

  it('has three 1024 × 768 screenshots', () => {
    const shots = readdirSync(join(root, 'src/assets')).filter((n) => n.startsWith('screenshot'));
    expect(shots.sort()).toEqual(['screenshot-0.png', 'screenshot-1.png', 'screenshot-2.png']);
    for (const shot of shots) expect(png(shot)).toMatchObject({ width: 1024, height: 768 });
  });
});
