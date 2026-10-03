// api/_lib/redact-url.js is a byte-for-byte copy of the repo-root redactor's code.
//
// There is meant to be ONE redactor, scripts/lib/redact-url.mjs, with its contract
// beside it in scripts/lib/redact-url.test.mjs. A serverless function cannot import it:
// the Vercel project's Root Directory is frontend/ and .vercelignore uploads frontend/
// only, so an import that reaches above frontend/ resolves locally and fails in the
// deployed function. The copy under api/_lib/ is what the function runs, and this test
// is what keeps it the same redactor. Edit the root file, then copy its code here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { redactRpcUrl as mirror } from "../_lib/redact-url.js";
import { redactRpcUrl as canonical } from "../../../scripts/lib/redact-url.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_FILE = join(HERE, "..", "..", "..", "scripts", "lib", "redact-url.mjs");
const MIRROR_FILE = join(HERE, "..", "_lib", "redact-url.js");

/** The code: everything from the first declaration on. The header prose may differ. */
function code(file) {
  const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const at = src.indexOf("const MASK = ");
  expect(at, `${file} declares MASK`).toBeGreaterThan(-1);
  return src.slice(at);
}

describe("api/_lib/redact-url.js mirrors scripts/lib/redact-url.mjs", () => {
  it("carries the same code, character for character", () => {
    expect(code(MIRROR_FILE)).toBe(code(ROOT_FILE));
  });

  it("and so gives the same answers", () => {
    const cases = [
      "https://solana-mainnet.g.alchemy.com/v2/FAKEKEYFAKEKEYFAKEKEYFAKEKEY0000",
      "https://memetics.finance/read/0x" + "ab".repeat(20) + "?ref=x#y",
      "https://user:pass@example.com/rpc",
      "https://api.mainnet-beta.solana.com",
      "not a url",
      "",
    ];
    for (const c of cases) expect(mirror(c)).toBe(canonical(c));
  });
});
