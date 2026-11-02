import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __BUILD__: '"full"', __FIREFOX__: 'false', __SELF_UPDATING__: 'true' },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
