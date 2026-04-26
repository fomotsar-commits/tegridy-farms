import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// R002: only same-origin localhost dev servers may POST to the save handler.
// Defends against DNS-rebind, LAN-side CSRF, and arbitrary sites the dev
// happens to be visiting (a hostile tab can fetch() this URL otherwise).
const ART_STUDIO_ORIGIN_ALLOWLIST = new Set<string>([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);
const ART_STUDIO_MAX_BODY_BYTES = 64 * 1024; // 64 KB — matches Vercel default

function isAllowedOrigin(req: { headers: { origin?: string; referer?: string } }): boolean {
  const origin = req.headers.origin;
  if (origin) return ART_STUDIO_ORIGIN_ALLOWLIST.has(origin);
  // Fall back to Referer if Origin is absent (some clients drop it on
  // same-origin POSTs). Treat parse failure as a rejection.
  const referer = req.headers.referer;
  if (!referer) return false;
  try {
    const u = new URL(referer);
    return ART_STUDIO_ORIGIN_ALLOWLIST.has(`${u.protocol}//${u.host}`);
  } catch {
    return false;
  }
}

// R002: minimal schema validator. Rejects anything that is not the exact
// shape /art-studio sends — `artId` is the only required field per surface,
// `objectPosition` and `scale` are optional. Bound oversized strings/numbers
// to keep the saved file small and deterministic.
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

// Dev-only middleware that lets /art-studio persist picks to
// src/lib/artOverrides.ts. Disabled in production builds.
function artStudioPlugin(): Plugin {
  return {
    name: 'art-studio-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__art-studio/save', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        // R002: origin allowlist (must run before we read the body).
        if (!isAllowedOrigin(req)) {
          res.statusCode = 403;
          res.end('Forbidden: origin not allowed');
          return;
        }
        // R002: streaming body cap so an attacker can't make us buffer
        // unbounded data in dev memory.
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
          if (!isValidOverridePayload(parsed)) {
            res.statusCode = 400;
            res.end('Bad request: schema validation failed');
            return;
          }
          try {
            // Stable key order so diffs are clean.
            const keys = Object.keys(parsed).sort();
            const entries = keys.map((k) => {
              const v = parsed[k]!;
              const pos = v.objectPosition ? `, objectPosition: ${JSON.stringify(v.objectPosition)}` : '';
              const scale = v.scale && v.scale !== 1 ? `, scale: ${v.scale}` : '';
              return `  ${JSON.stringify(k)}: { artId: ${JSON.stringify(v.artId)}${pos}${scale} },`;
            }).join('\n');
            const file = `/**
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
`;
            const out = resolve(process.cwd(), 'src/lib/artOverrides.ts');
            writeFileSync(out, file, 'utf8');
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, count: keys.length }));
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [
      react(),
      tailwindcss(),
      artStudioPlugin(),
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
        // /api/etherscan is a Vercel serverless function in production.
        // For local dev we forward to the deployed proxy so the API key stays
        // server-side and we don't need a separate local key. Production
        // requests hit the function directly and never touch this proxy.
        '/api/etherscan': {
          target: 'https://tegridyfarms.vercel.app',
          changeOrigin: true,
        },
        // ═══ Nakamigos marketplace dev proxies ═══
        // Mimics the Vercel serverless functions locally
        '/api/alchemy': {
          target: 'https://eth-mainnet.g.alchemy.com',
          changeOrigin: true,
          rewrite: (path) => {
            const url = new URL(path, 'http://localhost');
            const endpoint = url.searchParams.get('endpoint') || '';
            const params = new URLSearchParams(url.searchParams);
            params.delete('endpoint');
            const key = env.ALCHEMY_API_KEY || env.VITE_ALCHEMY_API_KEY || '';
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
              const key = env.OPENSEA_API_KEY || env.VITE_OPENSEA_API_KEY || '';
              if (key) proxyReq.setHeader('x-api-key', key);
              proxyReq.setHeader('Accept', 'application/json');
            });
          },
        },
      },
    },
    build: {
      target: 'es2023',
      // R078: don't ship sourcemaps — even 'hidden' writes them to disk and
      // hosting CDNs sometimes leak them. Bundle internals stay private.
      sourcemap: false,
      // Fix: CSS preload errors on lazy-loaded chunks (Nakamigos App.css)
      // Vite's modulePreload inserts <link rel="modulepreload"> that can fail on some CDNs
      cssCodeSplit: true,
      modulePreload: { polyfill: false },
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
            if (id.includes('node_modules/html2canvas')) {
              return 'vendor-html2canvas';
            }
            if (id.includes('node_modules/recharts')) {
              return 'vendor-recharts';
            }
          },
        },
      },
    },
  };
})
