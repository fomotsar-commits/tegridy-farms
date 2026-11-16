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

// A FREE CANCEL IS NOT THE SAME NEWS AS AN ON-CHAIN ONE.
//
// cancelOrder (api-offers.js) cancels a bid through OpenSea without gas, and then
// OpenSea can still complete a sale it approved in the last 5 minutes. Its answer
// says so in `message`. A screen that toasts its own "cancelled successfully!"
// over that answer tells the user the order is dead while it can still fill (My
// Collection did, review 2026-11-16 F1). So every screen that calls cancelOrder
// words its success branch with the answer's own message.
describe("every screen that calls cancelOrder says what the cancel said", () => {
  // `const R = await cancelOrder(...)`, then `if (R.success) { ... }`: the
  // success branch must read `R.message`. A call in any other shape is reported,
  // so a new screen cannot slip past by being written differently.
  function cancelWording(path) {
    const kind = path.endsWith("x") ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, kind);
    const problems = [];
    let calls = 0;
    const reads = (node, name, prop) => {
      let found = false;
      const visit = (n) => {
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name && n.name.text === prop) found = true;
        if (!found) ts.forEachChild(n, visit);
      };
      visit(node);
      return found;
    };
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "cancelOrder") {
        calls += 1;
        const decl = ts.isAwaitExpression(node.parent) && ts.isVariableDeclaration(node.parent.parent) ? node.parent.parent : null;
        const name = decl && ts.isIdentifier(decl.name) ? decl.name.text : null;
        let scope = node.parent;
        while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
        const branches = [];
        const findIf = (n) => {
          if (ts.isIfStatement(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
            && n.expression.expression.text === name && n.expression.name.text === "success") branches.push(n.thenStatement);
          ts.forEachChild(n, findIf);
        };
        if (name && scope) findIf(scope);
        if (!name || branches.length === 0) problems.push("calls cancelOrder in a shape this check cannot read");
        else if (!branches.every((b) => reads(b, name, "message"))) problems.push(`its success branch does not show ${name}.message`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return { calls, problems };
  }

  const screens = walk(ROOT)
    .map((path) => ({ file: relative(ROOT, path).replace(/\\/g, "/"), ...cancelWording(path) }))
    .filter((f) => f.calls > 0 && !DEFINED_IN.has(f.file) && !(f.file in HANDS_IT_ON));

  it("finds the screens that call it (a scan that matched nothing would pass vacuously)", () => {
    expect(screens.map((f) => f.file)).toContain("components/MyCollection.jsx");
  });

  it("each one shows the answer's own message when the cancel succeeds", () => {
    const silent = screens.filter((f) => f.problems.length > 0).map((f) => `${f.file}: ${f.problems.join("; ")}`);
    expect(silent, "toast result.message on success: a free cancel's answer carries the 5-minute caveat").toEqual([]);
  });
});
