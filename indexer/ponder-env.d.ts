// This file enables type-safe imports from "ponder:registry" and "ponder:schema".
// It is auto-updated by `ponder codegen`.

declare module "ponder:registry" {
  import type { Virtual } from "ponder";
  type config = typeof import("./ponder.config.ts").default;
  type schema = typeof import("./ponder.schema.ts");
  export const ponder: Virtual.Registry<config, schema>;
}

declare module "ponder:schema" {
  export * from "./ponder.schema.ts";
}
