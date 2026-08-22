// Types for apiTiers.js — the shared API tier catalog.
//
// The runtime lives in the sibling .js because a Vercel lambda cannot import a
// .ts module; this file is erased at build time and exists so the browser side
// keeps full typing on the numbers it renders. Same arrangement as record-core.

export interface ApiTier {
  id: string;
  label: string;
  /** Monthly list price in USD. 0 for the free tier. */
  priceUsdMonthly: number;
  /** Calls included per calendar month before the quota gate. */
  includedCallsPerMonth: number;
  /** Per-key sliding-window ceiling, requests per minute. */
  rateLimitPerMinute: number;
  /**
   * Published intent only. Null means the tier has no overage at all; a number
   * means overage is INTENDED at that rate but cannot be charged while
   * API_BILLING_ENABLED is false — the quota hard-stops instead.
   */
  overageUsdPerCall: number | null;
  /** Whether the tier is mintable without an operator in the loop. */
  selfServe: boolean;
  blurb: string;
}

export interface ApiRoute {
  id: string;
  method: string;
  path: string;
  summary: string;
  /** True when anonymous callers are refused with 401 rather than served. */
  keyed: boolean;
  note: string;
}

export interface ApiRoadmapEntry {
  id: string;
  summary: string;
  blockedBy: string;
}

export interface ApiErrorSemantic {
  status: number;
  code: string;
  meaning: string;
}

export declare const API_ERROR_SEMANTICS: ApiErrorSemantic[];
export declare const API_BILLING_ENABLED: boolean;
export declare const API_PRICING_STATE: 'proposed' | 'published';
export declare const API_ROUTES: ApiRoute[];
export declare const API_ROADMAP: ApiRoadmapEntry[];
export declare const API_TIERS: Record<string, ApiTier>;
export declare const API_TIER_ORDER: string[];
export declare const DEFAULT_TIER_ID: string;
export declare function getTier(id: string | null | undefined): ApiTier | null;
export declare function isKnownTier(id: string | null | undefined): boolean;
export declare function isSelfServeTier(id: string): boolean;
