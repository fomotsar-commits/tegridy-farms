import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    // .test.{js,jsx} included for the nakamigos marketplace, which is plain JS
    include: ['src/**/*.test.{js,jsx,ts,tsx}', 'api/**/*.test.{js,ts}'],
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
