// Scratch config for this worktree only: its own preview port, never another session's 4173. Not committed.
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  reporter: 'list',
  outputDir: '../../_nsa-results',
  use: { ...base.use, baseURL: 'http://localhost:4391' },
  webServer: { command: 'npx vite preview --port 4391 --strictPort', port: 4391, reuseExistingServer: false },
});
