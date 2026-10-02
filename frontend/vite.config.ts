import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOverrideModule, mergeScoped, type OverrideEntry } from './src/lib/dev/overrideFileMerge';

// R002: only a same-origin localhost dev server may POST to the save handler
// (DNS rebinding, LAN CSRF, or any hostile tab could fetch() it otherwise).
const ART_STUDIO_ORIGIN_ALLOWLIST = new Set<string>([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);
const ART_STUDIO_MAX_BODY_BYTES = 64 * 1024; // 64 KB — matches Vercel default

function isAllowedOrigin(req: { headers: { origin?: string; referer?: string } }): boolean {
  const origin = req.headers.origin;
  if (origin) return ART_STUDIO_ORIGIN_ALLOWLIST.has(origin);
  // Referer when Origin is absent; an unparseable one is a rejection.
  const referer = req.headers.referer;
  if (!referer) return false;
  try {
    const u = new URL(referer);
    return ART_STUDIO_ORIGIN_ALLOWLIST.has(`${u.protocol}//${u.host}`);
  } catch {
    return false;
  }
}

// R002: exactly the shape a studio sends (`artId` required, `objectPosition` and
// `scale` optional), with bounded sizes so the saved file stays small.
function isValidOverridePayload(p: unknown): p is Record<string, { artId: string; objectPosition?: string; scale?: number }> {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (typeof k !== 'string' || k.length === 0 || k.length > 256) return false;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const entry = v as Record<string, unknown>;
    if (typeof entry.artId !== 'string' || entry.artId.length === 0 || entry.artId.length > 128) return false;
    if (entry.objectPosition !== undefined) {
      if (typeof entry.objectPosition !== 'string' || entry.objectPosition.length > 64) return false;
    }
    if (entry.scale !== undefined) {
      if (typeof entry.scale !== 'number' || !Number.isFinite(entry.scale) || entry.scale <= 0 || entry.scale > 16) return false;
    }
  }
  return true;
}

type OverrideSaveOptions = {
  /** Vite plugin name (shows up in build output / errors). */
  name: string;
  /** Dev-only POST route the studio saves to. */
  route: string;
  /** Path (relative to the frontend root) of the file to rewrite. */
  outFile: string;
  /** Key-shape guard beyond the generic validator (the classic studio has none). */
  keyPattern?: RegExp;
  /** The exported const in `outFile`: a scoped save reads the file back first. */
  exportName?: string;
  /** Render the whole module source from the sorted, validated payload. */
  render: (entries: string) => string;
};

// Dev-only middleware that lets a studio page persist picks to a source file.
function overrideSavePlugin(opts: OverrideSaveOptions): Plugin {
  return {
    name: opts.name,
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(opts.route, (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        // R002: before the body is read.
        if (!isAllowedOrigin(req)) {
          res.statusCode = 403;
          res.end('Forbidden: origin not allowed');
          return;
        }
        // R002: a streaming cap, so nothing buffers unbounded data.
        let body = '';
        let bytes = 0;
        let tooLarge = false;
        req.on('data', (chunk: Buffer | string) => {
          if (tooLarge) return;
          const chunkBytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
          bytes += chunkBytes;
          if (bytes > ART_STUDIO_MAX_BODY_BYTES) {
            tooLarge = true;
            res.statusCode = 413;
            res.end('Payload too large');
            req.destroy();
            return;
          }
          body += chunk;
        });
        req.on('end', () => {
          if (tooLarge) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch (err) {
            res.statusCode = 400;
            res.end(`Bad JSON: ${(err as Error).message}`);
            return;
          }
          // `{ scope, overrides }` replaces only the keys beginning `${scope}|`, so two
          // studio tabs cannot erase each other's saves; a bare map replaces the file.
          let scope: string | null = null;
          let payload: unknown = parsed;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'overrides' in (parsed as object)) {
            const env = parsed as { scope?: unknown; overrides?: unknown };
            if (typeof env.scope !== 'string' || !/^[a-z0-9-]{1,64}$/.test(env.scope)) {
              res.statusCode = 400;
              res.end('Bad request: scope must be a short slug');
              return;
            }
            scope = env.scope;
            payload = env.overrides;
          }

          if (!isValidOverridePayload(payload)) {
            res.statusCode = 400;
            res.end('Bad request: schema validation failed');
            return;
          }
          if (opts.keyPattern && !Object.keys(payload).every((k) => opts.keyPattern!.test(k))) {
            res.statusCode = 400;
            res.end('Bad request: key shape validation failed');
            return;
          }
          // A scoped save carries only its own keys: refused, never filtered.
          if (scope !== null && !Object.keys(payload).every((k) => k.startsWith(`${scope}|`))) {
            res.statusCode = 400;
            res.end(`Bad request: scoped save carried keys outside "${scope}|"`);
            return;
          }
          try {
            let merged: Record<string, OverrideEntry> = payload;
            if (scope !== null) {
              if (!opts.exportName) throw new Error('scoped save requires exportName');
              const target = resolve(process.cwd(), opts.outFile);
              let onDisk = '';
              try {
                onDisk = readFileSync(target, 'utf8');
              } catch { /* first write — nothing to preserve */ }
              const existing = onDisk ? parseOverrideModule(onDisk, opts.exportName) : {};
              merged = mergeScoped(existing, scope, payload);
            }
            // Stable key order so diffs are clean.
            const keys = Object.keys(merged).sort();
            const entries = keys.map((k) => {
              const v = merged[k]!;
              const pos = v.objectPosition ? `, objectPosition: ${JSON.stringify(v.objectPosition)}` : '';
              const scale = v.scale && v.scale !== 1 ? `, scale: ${v.scale}` : '';
              return `  ${JSON.stringify(k)}: { artId: ${JSON.stringify(v.artId)}${pos}${scale} },`;
            }).join('\n');
            const file = opts.render(entries);
            const out = resolve(process.cwd(), opts.outFile);
            // Written only on change: a no-op rewrite trips HMR, which remounts
            // the studio, which saves again, in a loop.
            let unchanged = false;
            try {
              unchanged = readFileSync(out, 'utf8') === file;
            } catch { /* first write — file may not exist */ }
            if (!unchanged) writeFileSync(out, file, 'utf8');
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, count: keys.length, written: !unchanged }));
          } catch (err) {
            // Write failure (ENOENT/EACCES) is a server fault, not a client one.
            res.statusCode = 500;
            res.end(`Server error: ${(err as Error).message}`);
          }
        });
      });
    },
  };
}

/**
 * Answer ten, ruling 2: the app stylesheets do not gate the first frame, whose critical
 * CSS is inline. Their links move from <head> to just after #root: a body stylesheet
 * still blocks what follows it and the module scripts, so React never commits unstyled.
 * fonts.css stays in <head>. Fails the build if the shape it relies on is missing.
 */
function firstFrameStylesheetsPlugin(): Plugin {
  return {
    name: 'first-frame-stylesheets',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const links = html.match(/<link rel="stylesheet" crossorigin href="\/assets\/[^"]+\.css">/g) ?? [];
        const anchor = '<!-- /first-frame --></div>';
        if (links.length === 0 || html.split(anchor).length !== 2) {
          throw new Error(
            `[first-frame-stylesheets] expected built stylesheet links and exactly one first-frame root; found ${links.length} links. index.html changed shape: update this plugin deliberately.`,
          );
        }
        let out = html;
        for (const link of links) out = out.replace(link, '');
        return out.replace(anchor, `${anchor}\n    ${links.join('\n    ')}`);
      },
    },
  };
}

// Vercel serves dist/<door>/index.html at /<door> before the SPA rewrite; vite preview
// would serve the stock shell there (only /<door>/ reaches the file). Preview only.
function doorPagesPreviewPlugin(): Plugin {
  return {
    name: 'door-pages-preview',
    configurePreviewServer(server) {
      const outDir = resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use((req, _res, next) => {
        const m = /^\/([a-z0-9-]+)(\?.*)?$/.exec(req.url ?? '');
        if ((req.method === 'GET' || req.method === 'HEAD') && m && existsSync(resolve(outDir, m[1]!, 'index.html'))) {
          req.url = `/${m[1]}/index.html${m[2] ?? ''}`;
        }
        next();
      });
    },
  };
}

// The studio endpoints render their whole module source, so the file stays deterministic.
function artStudioPlugin(): Plugin {
  return overrideSavePlugin({
    name: 'art-studio-save',
    route: '/__art-studio/save',
    outFile: 'src/lib/artOverrides.ts',
    exportName: 'ART_OVERRIDES',
    render: (entries) => `/**
 * Per-surface art overrides — written by /art-studio.
 *
 * Key format: \`\${pageId}:\${idx}\` (matches pageArt(pageId, idx) call sites).
 * \`artId\` must match an \`id\` in ART (see artConfig.ts).
 * \`objectPosition\` is a CSS object-position string (e.g. "center 30%", "50% 20%").
 *
 * Surfaces NOT listed here fall back to the deterministic rotation in pageArt().
 *
 * Do not hand-edit during a studio session — the studio overwrites this file on save.
 */
export type ArtOverride = {
  artId: string;
  objectPosition?: string;
  scale?: number;
};

export const ART_OVERRIDES: Record<string, ArtOverride> = {
${entries}
};
`,
  });
}

function bungalowStudioPlugin(): Plugin {
  return overrideSavePlugin({
    name: 'bungalow-studio-save',
    route: '/__bungalow-studio/save',
    outFile: 'src/lib/bungalowArtOverrides.ts',
    exportName: 'BUNGALOW_ART_OVERRIDES',
    // `bungalowId|pageId:idx` — lowercase slugs, non-negative index.
    keyPattern: /^[a-z0-9-]+\|[a-z0-9-]+:\d+$/,
    render: (entries) => `/**
 * Per-bungalow, per-surface art overrides — written by /bayla-studio.
 *
 * Key format: \`\${bungalowId}|\${pageId}:\${idx}\`.
 *   e.g. "bayla|farm:0" — the /farm page background, in the Bayla skin.
 *
 * Why a second file instead of reusing ART_OVERRIDES: a bungalow paints every
 * surface from its OWN pool (see bungalows.ts \`artPool\`), so the classic art
 * ids in ART_OVERRIDES don't exist in that pool. Keying by bungalow keeps the
 * two skins from overwriting each other — the classic picks stay exactly as
 * they are while a bungalow gets its own placement.
 *
 * \`artId\` resolves against the active bungalow's pool first, then falls back to
 * the classic ART map (so a bungalow may deliberately borrow a classic piece).
 * Unresolvable ids fall through to the deterministic rotation, same as classic.
 *
 * Do not hand-edit during a studio session — the studio overwrites this file on save.
 */
import type { ArtOverride } from './artOverrides';

export type { ArtOverride };

export const BUNGALOW_ART_OVERRIDES: Record<string, ArtOverride> = {
${entries}
};

/** Key builder — keep in lock-step with the studio and the vite save endpoint. */
export function bungalowOverrideKey(bungalowId: string, pageId: string, idx: number): string {
  return \`\${bungalowId}|\${pageId}:\${idx}\`;
}
`,
  });
}

// The door studio writes one pick per bungalow id, every door from one tab: whole-file.
function doorStudioPlugin(): Plugin {
  return overrideSavePlugin({
    name: 'door-studio-save',
    route: '/__door-studio/save',
    outFile: 'src/lib/bungalowDoorArt.ts',
    exportName: 'DOOR_ART_OVERRIDES',
    // A bare id: a surface studio's `|` key must never land in the door file.
    keyPattern: /^[a-z0-9-]{1,64}$/,
    render: (entries) => `/**
 * Per-bungalow DOOR art overrides — written by /door-studio.
 *
 * Key format: the bungalow id alone (e.g. "qr"). One door per resident.
 *
 * \`artId\` resolves against EVERY bungalow's pool and then the classic ART map,
 * because a door is the island's own shop window: the right picture for the QR
 * card may well come from another resident's drop, or from classic art. See
 * doorArt.ts for the resolver and the id-uniqueness guarantee it relies on.
 *
 * Surfaces NOT listed here fall back to the \`thumb\` / \`thumbPosition\` written on
 * the registry entry in bungalows.ts, which is where every door started.
 *
 * Do not hand-edit during a studio session — the studio overwrites this file on save.
 */
export type DoorArtOverride = {
  artId: string;
  objectPosition?: string;
};

export const DOOR_ART_OVERRIDES: Record<string, DoorArtOverride> = {
${entries}
};
`,
  });
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    // What src/lib/devServer.ts reads: only code this dev server compiles may honour the
    // operator dials. Never import.meta.env.DEV, which NODE_ENV can turn on in a build.
    define: { __VITE_DEV_SERVER__: JSON.stringify(command === 'serve') },
    plugins: [
      react(),
      tailwindcss(),
      artStudioPlugin(),
      bungalowStudioPlugin(),
      doorStudioPlugin(),
      firstFrameStylesheetsPlugin(),
      doorPagesPreviewPlugin(),
      ...(process.env.ANALYZE ? [visualizer({ open: true, gzipSize: true, filename: 'dist/bundle-analysis.html' })] : []),
    ],
    resolve: {
      alias: {
        '@': '/src',
      },
    },
    server: {
      proxy: {
        '/api/gecko': {
          target: 'https://api.geckoterminal.com/api/v2',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/gecko/, ''),
        },
        '/api/odos': {
          target: 'https://api.odos.xyz',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/odos/, ''),
        },
        '/api/cow': {
          target: 'https://api.cow.fi',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/cow/, ''),
        },
        '/api/lifi': {
          target: 'https://li.quest',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/lifi/, ''),
        },
        '/api/kyber': {
          target: 'https://aggregator-api.kyberswap.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/kyber/, ''),
        },
        '/api/openocean': {
          target: 'https://open-api.openocean.finance',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/openocean/, ''),
        },
        '/api/paraswap': {
          target: 'https://api.paraswap.io',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/paraswap/, ''),
        },
        // Mirrors the prod /api/jupiter function (api/aggregator/jupiter).
        '/api/jupiter': {
          target: 'https://lite-api.jup.ag',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/jupiter/, ''),
        },
        // Mirrors api/solrpc.js (server-only SOLANA_RPC_URL, or the keyless default).
        // The public RPC answers 403 to any request carrying an Origin, so the
        // browser-only headers are stripped, as the prod function never sends them.
        '/api/solrpc': {
          target: env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
          changeOrigin: true,
          rewrite: () => '/',
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.removeHeader('origin');
              proxyReq.removeHeader('referer');
              // Never reflect the dev browser's cookies at a third-party RPC.
              proxyReq.removeHeader('cookie');
            });
          },
        },
        // Dev forwards to the deployed function, so the key stays server-side.
        '/api/etherscan': {
          target: 'https://tegridyfarms.vercel.app',
          changeOrigin: true,
        },
        // Nakamigos marketplace: mimics the Vercel functions locally.
        '/api/alchemy': {
          target: 'https://eth-mainnet.g.alchemy.com',
          changeOrigin: true,
          rewrite: (path) => {
            const url = new URL(path, 'http://localhost');
            const endpoint = url.searchParams.get('endpoint') || '';
            const params = new URLSearchParams(url.searchParams);
            params.delete('endpoint');
            // [H-35] Server-only key: anything VITE_-prefixed ships in the client bundle.
            const key = env.ALCHEMY_API_KEY || '';
            if (!key) console.warn('[vite proxy] ALCHEMY_API_KEY is not set — Alchemy requests will fail.');
            if (endpoint === 'rpc') {
              return `/v2/${key}`;
            }
            const qs = params.toString();
            return `/nft/v3/${key}/${endpoint}${qs ? '?' + qs : ''}`;
          },
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('Accept', 'application/json');
            });
          },
        },
        '/api/opensea': {
          target: 'https://api.opensea.io',
          changeOrigin: true,
          rewrite: (path) => {
            const url = new URL(path, 'http://localhost');
            const apiPath = url.searchParams.get('path') || '';
            const params = new URLSearchParams(url.searchParams);
            params.delete('path');
            const qs = params.toString();
            return `/api/v2/${apiPath}${qs ? '?' + qs : ''}`;
          },
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              // [H-35] Server-only key, as above.
              const key = env.OPENSEA_API_KEY || '';
              if (key) proxyReq.setHeader('x-api-key', key);
              proxyReq.setHeader('Accept', 'application/json');
            });
          },
        },
      },
    },
    build: {
      target: 'es2023',
      // R078: no sourcemaps, not even 'hidden' ones, which reach disk and can leak.
      sourcemap: false,
      // CSS per lazy chunk (Nakamigos App.css failed to preload on some CDNs).
      cssCodeSplit: true,
      modulePreload: {
        polyfill: false,
        // Answer ten, ruling 2: the wallet stack loads after first paint. The HTML
        // does not modulepreload these vendor chunks, which the static frame never
        // needs; the entry still loads them, and lazy routes keep their preloads.
        resolveDependencies: (_filename, deps, { hostType }) =>
          hostType === 'html'
            ? deps.filter((d) => !/(^|\/)vendor-(wagmi|viem|crypto|shared-wallet-plumbing|framer|query)-/.test(d))
            : deps,
      },
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/') || id.includes('node_modules/react-router')) {
              return 'vendor-react';
            }
            if (id.includes('node_modules/viem')) {
              return 'vendor-viem';
            }
            if (id.includes('node_modules/wagmi') || id.includes('node_modules/@rainbow-me')) {
              return 'vendor-wagmi';
            }
            if (id.includes('node_modules/@tanstack/react-query')) {
              return 'vendor-query';
            }
            if (id.includes('node_modules/framer-motion')) {
              return 'vendor-framer';
            }
            if (id.includes('node_modules/@noble/') || id.includes('node_modules/@scure/')) {
              return 'vendor-crypto';
            }
            // Modules shared by the EVM stack and @solana/* are pinned here: left
            // unassigned, the bundler folds them into vendor-solana, and the eager
            // EVM chunks then import the whole Solana graph on first paint.
            if (
              id.includes('node_modules/eventemitter3/') ||
              id.includes('node_modules/@wallet-standard/') ||
              id.includes('node_modules/buffer/') ||
              id.includes('node_modules/base64-js/') ||
              id.includes('node_modules/ieee754/') ||
              // Shared by the Irys upload stack (EVM create flows) and @solana/web3.js.
              id.includes('node_modules/bs58/') ||
              id.includes('node_modules/base-x/') ||
              id.includes('node_modules/bn.js/') ||
              id.includes('node_modules/safe-buffer/')
            ) {
              return 'vendor-shared-wallet-plumbing';
            }
            // Only lazy Solana pages import these: out of the initial bundle.
            if (
              id.includes('node_modules/@solana/') ||
              id.includes('node_modules/@solana-mobile/')
            ) {
              return 'vendor-solana';
            }
            if (id.includes('node_modules/html2canvas')) {
              return 'vendor-html2canvas';
            }
          },
        },
      },
    },
  };
})
