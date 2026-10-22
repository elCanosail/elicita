import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';
import clerk from '@clerk/astro';
import { dark } from '@clerk/themes';
import { esES } from '@clerk/localizations';

const clerkAppearance = {
  baseTheme: dark,
  elements: {
    rootBox: { width: '100%' },
    card: {
      background: 'transparent',
      boxShadow: 'none',
      border: 'none',
      padding: '0',
    },
    headerTitle: { display: 'none' },
    headerSubtitle: { display: 'none' },
    socialButtonsBlockButton: {
      background: 'rgba(255,255,255,0.05)',
      border: '1px solid rgba(255,255,255,0.08)',
      color: 'rgba(255,255,255,0.6)',
      borderRadius: '6px',
    },
    formFieldInput: {
      background: 'rgba(255,255,255,0.05)',
      border: '1px solid rgba(255,255,255,0.1)',
      color: 'rgba(255,255,255,0.85)',
      borderRadius: '6px',
      fontFamily: "'Inter', sans-serif",
    },
    formFieldInputFocus: {
      borderColor: 'rgba(16,185,129,0.5)',
      outline: 'none',
    },
    formButtonPrimary: {
      background: '#059669',
      borderRadius: '6px',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: '13px',
      letterSpacing: '0.02em',
      color: 'white',
    },
    formButtonPrimaryHover: {
      background: '#10b981',
    },
    footerAction: { display: 'none' },
    formFieldLabel: {
      color: 'rgba(255,255,255,0.4)',
      fontSize: '12px',
    },
    dividerLine: { background: 'rgba(255,255,255,0.06)' },
    dividerText: {
      color: 'rgba(255,255,255,0.2)',
      fontSize: '11px',
    },
    identityPreviewText: { color: 'rgba(255,255,255,0.6)' },
    formResendCodeLink: { color: '#10b981' },
  },
};

// https://astro.build/config
export default defineConfig({
  site: 'https://elicita.es',
  base: '/',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    clerk({ localization: esES, appearance: clerkAppearance }),
    react(),
    tailwind({
      applyBaseStyles: false,
    }),
    sitemap(),
    mdx()
  ]
});
