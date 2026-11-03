import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        // 首个失败即停（与其它包同口径）
        bail: 1,
    },
});
