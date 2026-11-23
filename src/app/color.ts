import { getColor } from '@zendeskgarden/react-theming';
import type { DefaultTheme } from 'styled-components';

/**
 * A Garden colour variable (`background.default`, `foreground.subtle`…) for the theme's light or
 * dark mode. Garden's own `getColor` is typed through lodash's types, which this package does
 * not install; this gives it a plain signature.
 */
export const color = (theme: DefaultTheme, variable: string): string =>
  (getColor as (parameters: { theme: DefaultTheme; variable: string }) => string)({
    theme,
    variable,
  });
