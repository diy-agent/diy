import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['pkgs.ts/diy-app'],
  },
});
