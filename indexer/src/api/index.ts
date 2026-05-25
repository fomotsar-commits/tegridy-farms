import { ponder } from "ponder:registry";
import { graphql } from "ponder";

// ─── AUDIT M3 (2026-05-24): harden the public GraphQL serve ──────────────────
//
// Ponder's HTTP server (default port 42069) serves the GraphQL API with NO
// built-in authentication and NO rate-limiting. Left at the framework default
// it auto-mounts `graphql()` (Apollo defaults: depth 100 / 1000 tokens /
// 30 aliases) at `/` and `/graphql` — permissive enough that a single client
// can issue deeply-nested or alias-amplified queries that are expensive to
// resolve, i.e. a cheap DoS vector for a publicly-reachable endpoint.
//
// Registering this api file makes Ponder use OUR routes instead of the
// framework default, so we MUST re-mount the GraphQL middleware here (omitting
// it would remove the GraphQL surface entirely). We re-mount it at the same
// two paths the default uses, but with tightened query-complexity limits as a
// defense-in-depth control:
//
//   - maxOperationDepth:   12  (was 100) — frontend queries are shallow; this
//                                blocks pathologically nested queries.
//   - maxOperationAliases: 20  (was 30) — limits alias-based amplification.
//   - maxOperationTokens: 1000 (Apollo default, kept) — overall query size cap.
//
// IMPORTANT — these in-process limits are NOT a substitute for network-level
// controls. The GraphQL endpoint MUST be deployed behind a reverse proxy
// (nginx / Cloudflare / API gateway) that enforces:
//   * connection + request rate-limiting (Ponder has none), and
//   * authentication if the API is meant to be private (Ponder has none).
// Do NOT expose the Ponder HTTP port directly to the public internet.
// See https://ponder.sh/docs/query/api-functions#register-graphql-middleware
// and https://ponder.sh/docs/advanced/self-hosting.
const graphqlMiddleware = graphql({
  maxOperationDepth: 12,
  maxOperationAliases: 20,
  maxOperationTokens: 1000,
});

ponder.use("/graphql", graphqlMiddleware);
ponder.use("/", graphqlMiddleware);
