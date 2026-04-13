import type { StorybookConfig } from '@storybook/react-vite';
import { fileURLToPath } from 'url';
import path from 'path';
import remarkGfm from 'remark-gfm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: [
    '../src/**/*.mdx',
    '../src/**/*.stories.@(js|jsx|ts|tsx)',
  ],
  addons: [
    {
      name: '@storybook/addon-docs',
      options: { mdxPluginOptions: { mdxCompileOptions: { remarkPlugins: [remarkGfm] } } },
    },
    '@storybook/addon-themes',
  ],
  async viteFinal(config) {
    const { mergeConfig } = await import('vite');
    return mergeConfig(config, {
      resolve: {
        alias: {
          '@tauri-apps/api/core': path.resolve(__dirname, './tauri-mocks/api-core.ts'),
          '@tauri-apps/api/event': path.resolve(__dirname, './tauri-mocks/api-event.ts'),
          '@tauri-apps/api/app': path.resolve(__dirname, './tauri-mocks/api-app.ts'),
          '@tauri-apps/api/window': path.resolve(__dirname, './tauri-mocks/api-window.ts'),
          '@tauri-apps/plugin-dialog': path.resolve(__dirname, './tauri-mocks/plugin-dialog.ts'),
          '@tauri-apps/plugin-shell': path.resolve(__dirname, './tauri-mocks/plugin-shell.ts'),
        },
      },
    });
  },
};

export default config;
