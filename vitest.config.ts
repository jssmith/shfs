import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['**/src/**/*.test.ts', 'deploy/**/*.test.mjs'], exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'] } });
