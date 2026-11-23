import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createGlobalStyle, styled } from 'styled-components';
import { Anchor, Button } from '@zendeskgarden/react-buttons';
import { Dots } from '@zendeskgarden/react-loaders';
import { Alert } from '@zendeskgarden/react-notifications';
import { DEFAULT_THEME, ThemeProvider } from '@zendeskgarden/react-theming';
import { MD, SM } from '@zendeskgarden/react-typography';
import { ApiError, ConverterApi, errorOf, type Account } from '../api';
import { loadCatalog, type Catalog } from '../catalog';
import { readSettings, type Settings } from '../settings';
import type { ZafClient } from '../zaf';
import { listAttachments, requiresSignIn, ticketId, type TicketAttachment } from '../zendesk';
import { AttachmentCard } from './AttachmentCard';
import { color } from './color';
import { KEYS_URL, PRICING_URL, PRIVACY_URL } from './links';

type Scheme = 'light' | 'dark';

export interface Loaded {
  readonly api: ConverterApi;
  readonly settings: Settings;
  readonly account: Account;
  readonly catalog: Catalog;
  readonly attachments: readonly TicketAttachment[];
  /** The account requires a sign-in to open attachments (null: not known). */
  readonly signIn: boolean | null;
}

type State =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly error: ApiError }
  | ({ readonly state: 'ready' } & Loaded);

/** Everything the sidebar shows, read in parallel. */
export async function loadSidebar(client: ZafClient): Promise<Loaded> {
  const metadata = await client.metadata();
  const settings = readSettings(metadata.settings);
  const api = new ConverterApi(client, settings.baseUrl);
  const ticket = await ticketId(client);
  if (ticket === null)
    throw new ApiError('noTicket', 'Open a saved ticket to see its attachments.', 0);
  const [account, catalog, attachments, signIn] = await Promise.all([
    api.account(),
    loadCatalog(api),
    listAttachments(client, ticket),
    requiresSignIn(client),
  ]);
  return { api, settings, account, catalog, attachments, signIn };
}

export function App({
  client,
  initialScheme = 'light',
}: {
  readonly client: ZafClient | null;
  readonly initialScheme?: Scheme;
}) {
  const [scheme, setScheme] = useState<Scheme>(initialScheme);
  useEffect(() => {
    if (!client) return;
    // The agent's light or dark mode, and its changes (Zendesk's dark mode for apps).
    client
      .get('colorScheme')
      .then((answer) => {
        if (answer.colorScheme === 'dark' || answer.colorScheme === 'light')
          setScheme(answer.colorScheme);
      })
      .catch(() => undefined);
    client.on('colorScheme.changed', (value) => {
      if (value === 'dark' || value === 'light') setScheme(value);
    });
  }, [client]);
  const theme = useMemo(
    () => ({ ...DEFAULT_THEME, colors: { ...DEFAULT_THEME.colors, base: scheme } }),
    [scheme],
  );
  return (
    <ThemeProvider theme={theme}>
      <GlobalStyle />
      {client ? (
        <Sidebar client={client} />
      ) : (
        <Page>
          <MD>Open this app from a ticket in Zendesk.</MD>
        </Page>
      )}
    </ThemeProvider>
  );
}

function Sidebar({ client }: { readonly client: ZafClient }) {
  const [state, setState] = useState<State>({ state: 'loading' });
  const page = useRef<HTMLDivElement>(null);
  useFrameHeight(client, page);

  const load = useCallback(() => {
    setState({ state: 'loading' });
    loadSidebar(client).then(
      (loaded) => setState({ state: 'ready', ...loaded }),
      (error: unknown) => setState({ state: 'failed', error: errorOf(error) }),
    );
  }, [client]);
  useEffect(load, [load]);

  return (
    <Page ref={page}>
      {state.state === 'loading' && (
        <Center aria-live="polite">
          <Dots size={32} aria-label="Loading" />
        </Center>
      )}
      {state.state === 'failed' && <LoadError error={state.error} retry={load} />}
      {state.state === 'ready' && <Ready loaded={state} refresh={load} />}
    </Page>
  );
}

function LoadError({ error, retry }: { readonly error: ApiError; readonly retry: () => void }) {
  return (
    <Alert type={error.code === 'noTicket' ? 'info' : 'error'}>
      <Alert.Title>
        {error.code === 'invalidApiKey' ? 'Connect Converter Studio' : 'Converter Studio'}
      </Alert.Title>
      <Alert.Paragraph>{error.message}</Alert.Paragraph>
      {error.code === 'invalidApiKey' ? (
        <Alert.Paragraph>
          Make an API key on your{' '}
          <Anchor href={KEYS_URL} isExternal externalIconLabel="(opens in a new tab)">
            Converter Studio account page
          </Anchor>
          .
        </Alert.Paragraph>
      ) : (
        error.code !== 'noTicket' && (
          <Button size="small" onClick={retry}>
            Try again
          </Button>
        )
      )}
    </Alert>
  );
}

function Ready({ loaded, refresh }: { readonly loaded: Loaded; readonly refresh: () => void }) {
  const { attachments, catalog, api, settings, signIn } = loaded;
  const [credits, setCredits] = useState(loaded.account.credits);
  const converted = useCallback((used: number) => setCredits((c) => Math.max(0, c - used)), []);
  const convertible = attachments.filter(
    (a) => !a.blocked && catalog.targets(catalog.formatOf(a)).length > 0,
  );
  const others = attachments.filter((a) => !convertible.includes(a));
  return (
    <>
      <Header>
        <MD isBold>
          {attachments.length === 0
            ? 'No attachments'
            : `${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`}
        </MD>
        <Button size="small" isBasic onClick={refresh}>
          Refresh
        </Button>
      </Header>
      {attachments.length === 0 && (
        <Muted>Files customers or agents attach to this ticket show up here.</Muted>
      )}
      {signIn === true && convertible.length > 0 && (
        <Alert type="info">
          <Alert.Paragraph>
            Your Zendesk asks for a sign-in to open attachments, so Converter Studio cannot fetch
            them by their link. Save a file from the ticket, then choose it here.
          </Alert.Paragraph>
        </Alert>
      )}
      {convertible.map((attachment) => (
        <AttachmentCard
          key={attachment.id}
          attachment={attachment}
          catalog={catalog}
          api={api}
          limit={settings.maxCredits}
          signIn={signIn === true}
          onConverted={converted}
        />
      ))}
      {others.length > 0 && (
        <Muted>
          Not converted here:{' '}
          {others
            .map((a) => (a.blocked ? `${a.name} (flagged by Zendesk’s malware scan)` : a.name))
            .join(', ')}
          .
        </Muted>
      )}
      <Footer>
        <SM>
          {credits} credit{credits === 1 ? '' : 's'} left ·{' '}
          <Anchor href={PRICING_URL} isExternal externalIconLabel="(opens in a new tab)">
            Plans and credits
          </Anchor>
        </SM>
        <Muted>
          Files you convert are sent to converter.studio and deleted after 6 hours.{' '}
          <Anchor href={PRIVACY_URL} isExternal externalIconLabel="(opens in a new tab)">
            Privacy
          </Anchor>
        </Muted>
      </Footer>
    </>
  );
}

/** Tells Zendesk the frame's height whenever the sidebar's content changes size. */
function useFrameHeight(client: ZafClient, page: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const element = page.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let last = 0;
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(element.getBoundingClientRect().height) + 16;
      if (height === last) return;
      last = height;
      client.invoke('resize', { width: '100%', height: `${height}px` }).catch(() => undefined);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [client, page]);
}

const GlobalStyle = createGlobalStyle`
  html, body {
    margin: 0;
    background: ${(p) => color(p.theme, 'background.default')};
    color: ${(p) => color(p.theme, 'foreground.default')};
    font-family: ${(p) => p.theme.fonts.system};
  }
`;

const Page = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${(p) => p.theme.space.sm};
  padding: ${(p) => p.theme.space.xs} 2px;
`;

const Center = styled.div`
  display: flex;
  justify-content: center;
  padding: ${(p) => p.theme.space.md};
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
`;

const Footer = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${(p) => p.theme.space.xxs};
  border-top: ${(p) => p.theme.borders.sm} ${(p) => color(p.theme, 'border.default')};
  padding-top: ${(p) => p.theme.space.sm};
`;

export const Muted = styled(SM)`
  color: ${(p) => color(p.theme, 'foreground.subtle')};
`;
