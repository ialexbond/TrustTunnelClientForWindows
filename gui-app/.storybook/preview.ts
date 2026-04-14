import type { Preview, Renderer } from '@storybook/react-vite';
import { withThemeByDataAttribute } from '@storybook/addon-themes';
import '../src/shared/styles/tokens.css';
import '../src/index.css';
import './storybook-overrides.css';

const preview: Preview = {
  decorators: [
    withThemeByDataAttribute<Renderer>({
      themes: {
        dark: 'dark',
        light: 'light',
      },
      defaultTheme: 'dark',
      attributeName: 'data-theme',
    }),
  ],
  parameters: {
    backgrounds: { disable: true },
    layout: 'padded',
  },
};

export default preview;
