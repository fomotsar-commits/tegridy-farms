// LOCAL ONLY, never committed. The studio session's dev server: the repo's own
// config, minus vite's full-screen error overlay. In dev nothing serves
// /api/aggregator, so vite tries to transform the function's source, fails, and
// paints the overlay over every page that asks for a price, including the
// studio's Live-page preview.
import { defineConfig, mergeConfig, type ConfigEnv, type UserConfig } from 'vite';
import base from './vite.config';

export default defineConfig((env: ConfigEnv) =>
  mergeConfig((base as (e: ConfigEnv) => UserConfig)(env), { server: { hmr: { overlay: false } } }),
);
