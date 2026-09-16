import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '#credentials': fileURLToPath(new URL('./src/credentials.ts', import.meta.url)) },
  },
});
