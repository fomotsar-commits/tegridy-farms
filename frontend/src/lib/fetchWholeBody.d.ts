// Types for fetchWholeBody.js. The runtime is plain JS so api/_lib/seaport-verify.js can
// import it (src/lib/merkle/core.d.ts has the same layout).

/** `fetch`, returning only once the whole body has arrived. Made for viem's `fetchFn`. */
export declare function fetchWholeBody(input: string | URL | Request, init?: RequestInit): Promise<Response>;
