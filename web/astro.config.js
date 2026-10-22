import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';
import node from '@astrojs/node';
import clerk from '@clerk/astro';
import { esES } from '@clerk/localizations';

// https://astro.build/config
export default defineConfig({
  site: 'https://elicita.es',
  base: '/',
  outDir: 'dist-staging',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    clerk({ localization: esES }),
    react(),
    sitemap({
      i18n: { defaultLocale: 'es', locales: { es: 'es-ES' } },
      filter: (page) => {
        const exclude = [
          '/cuenta',
          '/monitor',
          '/explorer',
          '/dashboard',
          '/api',
          '/sign-in',
          '/sign-up',
          '/buscador',
          '/advanced-components',
          '/components',
          '/proximamente',
          '/markdown-page',
        ];
        return !exclude.some((prefix) => page.includes(prefix));
      },
      serialize: (item) => {
        if (item.url.includes('/licitaciones/')) {
          item.changefreq = 'daily';
          item.priority = 0.7;
        }
        return item;
      }
    }),
    mdx()
  ]
});
