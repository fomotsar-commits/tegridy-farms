// The marketplace waits for a transaction in exactly one place.
//
// ethers' `tx.wait()` throws for a revert, for a speed-up and for a receipt it
// could not read, and never settles at all for a replaced transaction that was
// sent through a contract method. lib/txOutcome.js is the one caller that knows
// that. A bare `.wait()` anywhere else is the old bug: a purchase that landed,
// reported as failed.
//
// The source is PARSED, not grepped, so a comment or a string that names
// `.wait()` is not the call, and a call is found however it is spaced.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(process.cwd(), "src", "nakamigos");
const HELPER = "lib/txOutcome.js";

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, acc);
    else if (/\.jsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) acc.push(path);
  }
  return acc;
}

/** Every call in a file, as the name it is called by: `wait` for `tx.wait()`. */
function calls(path) {
  const found = { methods: [], functions: [] };
  const kind = path.endsWith("x") ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) found.methods.push(callee.name.text);
      else if (ts.isIdentifier(callee)) found.functions.push(callee.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, false, kind));
  return found;
}

const files = walk(ROOT).map((path) => ({ file: relative(ROOT, path).replace(/\\/g, "/"), ...calls(path) }));
const count = (list, name) => list.filter((n) => n === name).length;

describe("every transaction wait goes through waitForTxOutcome", () => {
  it("finds the waits (a scan that matched nothing would pass vacuously)", () => {
    const waits = files.reduce((n, f) => n + count(f.functions, "waitForTxOutcome"), 0);
    expect(waits).toBeGreaterThanOrEqual(15);
  });

  it("calls .wait() nowhere but the helper", () => {
    const bare = files
      .filter((f) => f.file !== HELPER && count(f.methods, "wait") > 0)
      .map((f) => `${f.file}: ${count(f.methods, "wait")}`);
    expect(bare, "use waitForTxOutcome() from lib/txOutcome.js: a bare tx.wait() calls a speed-up a failure").toEqual([]);
    expect(count(files.find((f) => f.file === HELPER).methods, "wait")).toBe(1);
  });
});

// The functions that return a waited transaction's result to a screen.
const SITE_FUNCTIONS = [
  "fulfillSeaportOrder", "fulfillNativeOrder", "acceptOffer", "cancelOrder",
  "createItemOffer", "createCollectionOffer", "createTraitOffer",
  "createNativeListing", "createNativeBundleListing",
  "createTradeOffer", "acceptTrade", "acceptOpenTrade", "cancelTradeOnChain",
];
const DEFINED_IN = new Set(["api.js", "api-offers.js", "lib/orderbook.js", "lib/trades.js"]);

/** Callers that hand the result on instead of wording it, and to whom. */
const HANDS_IT_ON = {
  "components/Modal.jsx": "passes the result to TransactionProgress as onExecute, which words it",
  "hooks/useTradingMutations.js": "react-query mutations that return the result untouched; nothing imports them",
};

describe("every screen that shows a transaction result words a notice as a notice", () => {
  // "unconfirmed" and "replaced" are neither a success nor a failure. A screen
  // that drops them into its failure branch says "failed, try again" about a
  // purchase that may have landed, and getFriendlyError turns any message over
  // 120 characters into exactly that.
  const callers = files.filter((f) => !DEFINED_IN.has(f.file) && SITE_FUNCTIONS.some((name) => count(f.functions, name) > 0));

  it("finds the screens, and every site function is called by one", () => {
    expect(callers.length).toBeGreaterThanOrEqual(12);
    const uncalled = SITE_FUNCTIONS.filter((name) => !callers.some((f) => count(f.functions, name) > 0));
    expect(uncalled, "a name here matches no call: the list has drifted from the code").toEqual([]);
  });

  it("each one calls toastTxNotice() or isTxNotice()", () => {
    const silent = callers
      .filter((f) => !(f.file in HANDS_IT_ON))
      .filter((f) => count(f.functions, "toastTxNotice") + count(f.functions, "isTxNotice") === 0)
      .map((f) => f.file);
    expect(silent, "these screens have no branch for an unconfirmed or replaced transaction").toEqual([]);
  });

  it("names no hand-off that is no longer there", () => {
    const stale = Object.keys(HANDS_IT_ON).filter((file) => !callers.some((f) => f.file === file));
    expect(stale).toEqual([]);
  });
});
