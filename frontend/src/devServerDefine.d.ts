// True only for code a Vite dev server compiled. vite.config.ts defines it from the command
// (`vite` true, `vite build` false), vitest.config.ts defines it true, and a loader that
// defines nothing (a build script's own Vite server) leaves it undefined. The operator
// dials read it (heat/heatGateConfig.ts, launcher/solana/curveWriteFlag.ts), never DEV
// alone: Vite inlines import.meta.env.DEV from NODE_ENV even in `vite build`.
declare const __VITE_DEV_SERVER__: boolean | undefined;
