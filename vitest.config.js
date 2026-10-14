import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/unit/**/*.test.js'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'build/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.js'],
      exclude: [
        '**/node_modules/**',
        'build/**',
        'tests/**'
      ]
    },
    environmentMatchGlobs: [
      ['tests/unit/sidebar/**', 'jsdom'],
      ['tests/unit/content/**', 'jsdom'],
      ['tests/unit/utils/analytics.test.js', 'jsdom']
    ]
  }
});
