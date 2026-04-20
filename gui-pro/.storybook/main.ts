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
    // remark-gfm enables GitHub-flavored markdown в MDX docs (tables,
    // strikethrough, task lists, autolinks). Без него pipe-таблицы в
    // Colors.mdx / Shadows.mdx / Spacing.mdx / Typography.mdx
    // рендерились как raw `| ... |` текст вместо HTML <table>.
    // См. CLAUDE.md Gotchas + memory/v3/design-system/storybook.md.
    {
      name: '@storybook/addon-docs',
      options: {
        mdxPluginOptions: {
          mdxCompileOptions: {
            remarkPlugins: [remarkGfm],
          },
        },
      },
    },
    '@storybook/addon-themes',
  ],
  async viteFinal(config) {
    const { mergeConfig } = await import('vite');
    return mergeConfig(config, {
      server: {
        hmr: { port: 6007 },
      },
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
