import type { Preview, Renderer } from '@storybook/react-vite';
import type { ReactRenderer } from '@storybook/react';
import type { DecoratorFunction } from '@storybook/csf';
import { withThemeByDataAttribute } from '@storybook/addon-themes';
import React from 'react';
import { SnackBarProvider } from '../src/shared/ui/SnackBarContext';
import '../src/shared/i18n';
import '../src/shared/styles/tokens.css';
import '../src/index.css';
import './storybook-overrides.css';

const withProviders: DecoratorFunction<ReactRenderer> = (Story) =>
  React.createElement(SnackBarProvider, null, React.createElement(Story));

const preview: Preview = {
  decorators: [
    withProviders as any,
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
