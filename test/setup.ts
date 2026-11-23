/**
 * Browser APIs Garden's components use and jsdom does not have. They do nothing here; the
 * frame's height is Zendesk's business.
 */
class NoResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const scope = globalThis as unknown as Record<string, unknown>;
scope.ResizeObserver ??= NoResizeObserver;
scope.matchMedia ??= (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
