import 'styled-components';
import type { IGardenTheme } from '@zendeskgarden/react-theming';

// The theme styled components receive is Zendesk Garden's (ThemeProvider in app/App.tsx).
declare module 'styled-components' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface DefaultTheme extends IGardenTheme {}
}
