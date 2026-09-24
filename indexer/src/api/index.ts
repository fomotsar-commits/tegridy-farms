import { ponder } from "ponder:registry";
import { graphql } from "ponder";
import { cors } from "hono/cors";

// This file replaces Ponder's default routes, so it must re-mount GraphQL at `/` and
// `/graphql`. It does so with tighter limits than Apollo's defaults (depth 100 -> 12,
// aliases 30 -> 20, tokens 1000 kept). They cap the cost of one query, not the number of
// queries: Ponder has no auth and no rate limit, so the service sits behind a proxy that
// rate-limits and its own port is never public (indexer/DEPLOY.md section 3).
const graphqlMiddleware = graphql({
  maxOperationDepth: 12,
  maxOperationAliases: 20,
  maxOperationTokens: 1000,
});

// The venue's own hosts; ALLOWED_ORIGINS (comma-separated) adds preview hosts. memetic.fun
// is not one: since 2026-09-20 it serves the Island Lab. Ponder 0.8 mounts
// cors({ origin: "*" }) ahead of this, so it answers every preflight and an unlisted origin
// keeps "*": this list decides which origins are echoed by name, not who can read.
// Pinned by frontend/src/test/indexerOrigins.test.ts.
const allowedOrigins = [
  "https://memetics.finance",
  "https://www.memetics.finance",
  "https://tegridyfarms.vercel.app",
  ...(process.env.ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
];
const corsMiddleware = cors({
  origin: (origin) => (origin && allowedOrigins.includes(origin) ? origin : ""),
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  credentials: false,
  maxAge: 86400,
});

ponder.use("/graphql", corsMiddleware, graphqlMiddleware);
ponder.use("/", corsMiddleware, graphqlMiddleware);
