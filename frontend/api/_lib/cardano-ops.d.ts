// Types for cardano-ops.js, so vite.config.ts (the dev server) can share it.
export declare const KOIOS_BASE: string;
export declare const MINSWAP_V2_POOL_SCRIPT: string;
export declare const MINSWAP_V2_AUTHEN_POLICY: string;
export declare const CARDANO_OPS: Record<string, { params: readonly string[]; cache: string; build: (q: Record<string, string>) => unknown }>;
export declare function buildKoiosRequest(
  op: unknown,
  query: Record<string, unknown> | undefined,
  apiKey: string | undefined,
): { url: string; init: RequestInit; cache: string } | { error: number; message: string };
