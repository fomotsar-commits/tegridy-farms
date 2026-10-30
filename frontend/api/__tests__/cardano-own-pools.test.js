// The venue's own Cardano pools' reads (_lib/cardano-ops.js ownPoolOps): none exist while the
// deployment record is null, and once it exists each is pinned to it; the caller names only an
// LP token, never a script, a policy or a path.
import { describe, it, expect } from "vitest";
import { buildKoiosRequest, CARDANO_OPS, ownPoolOps } from "../_lib/cardano-ops.js";
import { OWN_POOLS_DEPLOYMENT } from "../_lib/cardano-own-pools.js";
import { MINSWAP_V2 } from "../../src/lib/cardano/minswapV2";
import { TEST_RECORD } from "../../src/lib/cardano/ownPools/testWorld.fixture";

const LP = "a0e145a43dd4d48e4bd8cdf676206ec7c9ee4f4de1e427dceebc063dcc94959a";

describe("own-pool reads", () => {
  it("do not exist while the record is null: no request can reach any pool of ours, or anyone's, through them", () => {
    expect(OWN_POOLS_DEPLOYMENT).toBeNull();
    for (const op of ["ownpool", "ownfactory", "ownsetting"]) {
      expect(Object.prototype.hasOwnProperty.call(CARDANO_OPS, op)).toBe(false);
      expect(buildKoiosRequest(op, op === "ownpool" ? { lp: LP } : {}, "")).toEqual({ error: 404, message: "Unknown Cardano read" });
    }
  });

  it("read our pool script under our policy, the caller's LP name only", () => {
    const ops = ownPoolOps(TEST_RECORD);
    const r = ops.ownpool.build({ lp: LP });
    expect(r.path).toBe(`/asset_utxos?payment_cred=eq.${TEST_RECORD.poolScriptHash}`);
    expect(r.body).toEqual({ _asset_list: [[TEST_RECORD.authenPolicy, LP]], _extended: true });
    expect(r.path).not.toContain(MINSWAP_V2.poolScriptHash);
    expect(ops.ownpool.build({ lp: "zz" })).toBeNull();
    expect(ops.ownpool.build({ lp: `${LP}00` })).toBeNull();
    expect(ops.ownpool.build({})).toBeNull();
  });

  it("read our factory's list (paged, so a long one is called unread) and our one settings token", () => {
    const ops = ownPoolOps(TEST_RECORD);
    expect(ops.ownfactory.params).toEqual([]);
    expect(ops.ownfactory.build({})).toEqual({
      path: `/asset_utxos?payment_cred=eq.${TEST_RECORD.factoryScriptHash}&limit=1000`,
      method: "POST",
      body: { _asset_list: [[TEST_RECORD.authenPolicy, "4d5346"]], _extended: true },
    });
    expect(ops.ownsetting.build({})).toEqual({
      path: `/asset_utxos?payment_cred=eq.${TEST_RECORD.authenPolicy}`,
      method: "POST",
      body: { _asset_list: [[TEST_RECORD.authenPolicy, "4d534753"]], _extended: true },
    });
  });

  it("cache only what is the same for every visitor", () => {
    const ops = ownPoolOps(TEST_RECORD);
    expect(ops.ownpool.cache).toBe("private, no-store");
    expect(ops.ownfactory.cache).toBe("private, no-store");
    expect(ops.ownsetting.cache).toMatch(/^public/);
  });
});
