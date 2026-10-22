/**
 * Post-build script for Elicita
 * Merges static sitemaps with Astro-generated ones
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';

const DIST = 'dist-staging/client';

// Copy static sitemaps that Astro doesn't generate
const staticSitemaps = ['sitemap-blog.xml'];
for (const file of staticSitemaps) {
  if (existsSync(`public/${file}`)) {
    copyFileSync(`public/${file}`, `${DIST}/${file}`);
    console.log(`  ✓ Copied ${file}`);
  }
}

// Replace Astro's sitemap-index.xml with our merged version
if (existsSync('public/sitemap-index.xml')) {
  copyFileSync('public/sitemap-index.xml', `${DIST}/sitemap-index.xml`);
  console.log('  ✓ Replaced sitemap-index.xml with merged version');
}

// Copy robots.txt (Astro may strip our custom entries)
if (existsSync('public/robots.txt')) {
  copyFileSync('public/robots.txt', `${DIST}/robots.txt`);
  console.log('  ✓ Copied robots.txt');
}

// Ensure _astro assets exist in dist/client (Astro server mode may only put them in dist/server)
const serverAstro = 'dist-staging/server/_astro';
const clientAstro = 'dist-staging/client/_astro';
if (existsSync(serverAstro)) {
  if (!existsSync(clientAstro)) mkdirSync(clientAstro, { recursive: true });
  let copied = 0;
  for (const file of readdirSync(serverAstro)) {
    const src = join(serverAstro, file);
    const dst = join(clientAstro, file);
    copyFileSync(src, dst);
    copied++;
  }
  if (copied > 0) console.log(`  ✓ Synced ${copied} _astro assets to dist/client`);
}

console.log('  Post-build complete.');

// Sitemap segmentado de fichas /licitacion (tarea 38). Degradación suave sin
// BD (build sin producción); guardas de conteo → throw = build en voz alta si
// el sitemap saliera incompleto (nunca se publica recortado sin querer).
const { generateSitemapLicitaciones } = await import('./scripts/sitemap-licitaciones.mjs');
await generateSitemapLicitaciones();

// Sitemap segmentado de perfiles /perfil/<nif> (tarea 42). Misma degradación
// suave sin BD y mismas guardas de conteo que el de fichas.
const { generateSitemapPerfiles } = await import('./scripts/sitemap-perfiles.mjs');
await generateSitemapPerfiles();