// @vitest-environment node
// The dev server answers /api/<route> by running api/<route>.js, as Vercel does. Without
// that, Vite's module server takes the extensionless path for a module: it serves the
// server source as browser JS, and a query holding a slash breaks its relative imports.
// Every request here is answered by a handler's own guard, so none reaches the network.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

let server: ViteDevServer;
let base = '';

beforeAll(async () => {
  server = await createServer({
    configFile: fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  base = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
  // A cold load of aggregator.js and its imports outlasts a test's 5s clock; the hook has 30s.
  await server.ssrLoadModule(fileURLToPath(new URL('../../api/aggregator.js', import.meta.url)));
}, 30_000);

afterAll(async () => {
  await server?.close();
});

async function get(path: string) {
  const res = await fetch(base + path);
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
}

describe('dev /api runs the function, never the module server', () => {
  it('a query carrying a path reaches the handler', async () => {
    const r = await get('/api/aggregator?resource=gecko-read&path=/not/an/allowed/path');
    expect(r.type).toMatch(/^application\/json/);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: 'Unsupported path' });
  });

  it('a query without a slash reaches the handler, not the source', async () => {
    const r = await get('/api/aggregator?resource=gecko-read');
    expect(r.type).toMatch(/^application\/json/);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: 'Unsupported path' });
  });

  it('a helper under api/_lib or an unknown route is a JSON 404', async () => {
    for (const path of ['/api/_lib/heat', '/api/no-such-route', '/api/aggregator/nope']) {
      const r = await get(path);
      expect(r.status, path).toBe(404);
      expect(r.type, path).toMatch(/^application\/json/);
    }
  });

  // src/ imports api/_lib/apiTiers.js and record-core.js, so the browser loads them by URL.
  it('a module URL under /api still reaches the module server', async () => {
    const r = await get('/api/_lib/apiTiers.js');
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/javascript/);
    expect(r.body).toContain('API_TIERS');
  });
});
