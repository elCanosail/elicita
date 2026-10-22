import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  const sorted = posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());

  return rss({
    title: 'Blog — elicita_',
    description: 'Análisis, metodología y perspectivas sobre contratación pública española',
    site: context.site ?? 'https://elicita.es',
    items: sorted.map(post => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.excerpt,
      link: `/blog/${post.id}`,
      categories: [post.data.category, ...post.data.tags],
    })),
    customData: '<language>es</language>',
  });
}
