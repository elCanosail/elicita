import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = process.env.OPEN_DATA_CHECK_URL;
const pageUrl = baseUrl ? new URL('/datos-abiertos', baseUrl) : null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const html = pageUrl
  ? await fetch(pageUrl, { redirect: 'error' }).then(response => {
      assert(response.ok, `/datos-abiertos respondió ${response.status}.`);
      return response.text();
    })
  : await readFile(resolve('dist/client/datos-abiertos/index.html'), 'utf8');

assert(/<html[^>]*\bdark\b/i.test(html), 'La página estática debe renderizar el tema oscuro en HTML.');
assert((html.match(/<h1(?:\s|>)/gi) ?? []).length === 1, 'La página debe tener exactamente un h1.');
assert(html.includes('id="data-transparency-heading"'), 'Falta el bloque reutilizable DataTransparency.');
assert(html.includes('role="status"'), 'El fallback honesto debe anunciar su estado.');
assert(html.includes('No hay un snapshot de Tecnología validado y verificable para publicar todavía.'), 'El fallback no explica por qué se ocultan las cifras.');
assert(!/href="\/data\/market-intelligence\/technology\/latest\//.test(html), 'No debe ofrecer descargas sin un snapshot validado.');
assert(!html.includes('<astro-island'), 'La página no debe depender de islas JavaScript hidratadas.');

const links = ['/datos-abiertos', '/reutilizacion-y-atribucion', '/fuentes'];
for (const path of links) {
  assert(html.includes(`href="${path}"`), `Falta el enlace interno ${path}.`);
  if (baseUrl) {
    const response = await fetch(new URL(path, baseUrl), { redirect: 'error' });
    assert(response.ok, `El enlace interno ${path} respondió ${response.status}.`);
  }
}

console.log('✓ /datos-abiertos: HTML funcional sin hidratación, fallback, estructura accesible y enlaces verificados');
