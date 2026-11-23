import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { initClient } from './zaf';

/** The ticket sidebar: Zendesk opens `assets/iframe.html` and its SDK registers the app. */
const root = createRoot(document.getElementById('root')!);
const client = initClient();
root.render(
  <StrictMode>
    <App client={client} initialScheme={schemeFromUrl(window.location.search)} />
  </StrictMode>,
);
// When Zendesk closes the app (the ticket's tab closes), unmounting cancels any conversion still
// being waited for: each card aborts its requests and stops its status polling.
client?.on('app.willDestroy', () => root.unmount());

/** Zendesk puts the agent's light or dark mode in the frame's URL (`colorScheme`). */
function schemeFromUrl(search: string): 'light' | 'dark' {
  return new URLSearchParams(search).get('colorScheme') === 'dark' ? 'dark' : 'light';
}
