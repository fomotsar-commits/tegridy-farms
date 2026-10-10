// LOCAL, UNCOMMITTED. Own port, own preview, own output: never another session's :4173.
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const PORT = Number(process.env.PW_PORT ?? 4343);
const DIST = process.env.PW_DIST ?? 'dist';

export default defineConfig({
  ...base,
  testDir: process.env.PW_TESTDIR ?? './e2e',
  reporter: 'list',
  outputDir: `test-results-local-${PORT}`,
  use: { ...base.use, baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort --outDir ${DIST}`,
    port: PORT,
    reuseExistingServer: false,
  },
});
