import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body) as Record<string, { artId: string; objectPosition?: string; scale?: number }>;
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
            res.statusCode = 400;
            res.end(`Bad request: ${(err as Error).message}`);
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
      sourcemap: 'hidden',
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
