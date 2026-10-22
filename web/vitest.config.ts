import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.json'] })],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/lib/__tests__/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});