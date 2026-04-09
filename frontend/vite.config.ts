import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss()],
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
      sourcemap: false,
    },
  };
})
