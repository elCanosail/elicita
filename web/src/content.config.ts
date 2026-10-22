import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    excerpt: z.string(),
    date: z.coerce.date(),
    readTime: z.string(),
    category: z.string(),
    series: z.enum([
      'Market Intelligence',
      'Radiografía',
      'Dossiers de compradores',
      'Guías y producto',
    ]).default('Guías y producto'),
    seriesOrder: z.number().int().positive().optional(),
    author: z.string().default('Equipo Elicita'),
    tags: z.array(z.string()).default([]),
    image: z.string().optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };