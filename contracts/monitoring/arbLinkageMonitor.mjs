#!/usr/bin/env node
// Arb-linkage monitor — the load-bearing safety condition for the core-loop
// oracle unlock (docs/GOLIVE_CORELOOP.md §"Conditions", B4 / condition 3).
//
// The TWAP oracle reads the NATIVE TOWELI/WETH pool. That pool is safe from
// price manipulation ONLY while a DEEPER, arb-linked venue (the ~$26k UNCX-locked
// Uniswap TOWELI/WETH pool) keeps it honest — an attacker who pumps the native
// pool is arbed back by anyone bridging price from Uniswap, making a sustained
// TWAP dislocation EV-negative. The adversarial review's load-bearing assumption
// is: "the native pool is NOT the only liquid venue."
//
// This monitor makes that assumption OBSERVABLE. It compares the WETH depth of
// the two pools and emits GO / WARN / HALT:
//   - HALT  (exit 2): Uniswap WETH depth < 3x native  -> the native pool is
//                     becoming the dominant venue; manipulation cost collapses.
//                     ACTION: emergency-pause oracle-consuming features
//                     (NFT-lending, token-lending, POL.accumulate).
//   - WARN  (exit 1): < 4x  -> react before it becomes a HALT (deepen native or
//                     investigate the Uniswap-side drain).
//   - GO    (exit 0): >= 4x -> the arb linkage holds.
// It also flags if the native pool is below the 1.0-WETH live floor, or empty.
//
// Dependency-free: raw JSON-RPC over fetch (node >= 18). Keyless RPC roster with
// fallback (publicnode/drpc/merkle live; ankr/cloudflare/llamarpc dead — do not
// re-add). Read-only; it NEVER signs. The "auto-pause" half is a separate
// operator hook that consumes a HALT (exit 2 / {"status":"HALT"} JSON).
//
// USAGE:
//   node arbLinkageMonitor.mjs            # human-readable, exit code = severity
//   node arbLinkageMonitor.mjs --json     # machine-readable line for alerting/cron
// CRON (every 5 min, page on HALT):
//   node arbLinkageMonitor.mjs --json || alert "$(...)"     # exit>0 => act

const RPCS = (process.env.RPC ? [process.env.RPC] : []).concat([
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://eth.merkle.io',
]);

// Mainnet defaults (override via env). WETH is the shared numeraire.
const WETH = (process.env.WETH || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2').toLowerCase();
const NATIVE_PAIR = process.env.NATIVE_PAIR || '0x55875887B43C2E23aE424AF0FC8606Fdb058a481'; // TegridyPair (oracle source)
const UNISWAP_PAIR = process.env.UNISWAP_PAIR || '0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D'; // deep UNCX-locked venue

const HALT_RATIO = Number(process.env.HALT_RATIO || 3); // emergency-pause below this
const WARN_RATIO = Number(process.env.WARN_RATIO || 4); // react below this
const LIVE_FLOOR_WETH = Number(process.env.LIVE_FLOOR_WETH || 1.0); // native must clear the TWAP floor
const JSON_OUT = process.argv.includes('--json');

const SEL_GET_RESERVES = '0x0902f1ac'; // getReserves()
const SEL_TOKEN0 = '0x0dfe1681'; // token0()

async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    // Manual controller + cleared timer (not AbortSignal.timeout): the timeout
    // handle must be cleared before exit, else libuv asserts on close (Windows).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`all RPCs failed: ${lastErr?.message || lastErr}`);
}

const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const word = (hex, i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
const addrFromWord = (hex, i) => '0x' + hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64);

/** Return the WETH-side reserve (in WETH, float) and the pool's raw reserves. */
async function wethDepth(pair) {
  const [reservesHex, token0Hex] = await Promise.all([ethCall(pair, SEL_GET_RESERVES), ethCall(pair, SEL_TOKEN0)]);
  const r0 = word(reservesHex, 0);
  const r1 = word(reservesHex, 1);
  const token0 = addrFromWord(token0Hex, 0).toLowerCase();
  const wethIsToken0 = token0 === WETH;
  const wethWei = wethIsToken0 ? r0 : r1;
  return { wethWei, wethEth: Number(wethWei) / 1e18, r0, r1, empty: r0 === 0n || r1 === 0n };
}

function decide(nativeWeth, uniWeth) {
  if (nativeWeth <= 0) return { status: 'HALT', code: 2, reason: 'native pool empty / not seeded — oracle must not be live' };
  const ratio = uniWeth / nativeWeth;
  if (ratio < HALT_RATIO) return { status: 'HALT', code: 2, ratio, reason: `arb venue depth ${ratio.toFixed(2)}x < ${HALT_RATIO}x native — pause oracle features` };
  if (nativeWeth < LIVE_FLOOR_WETH) return { status: 'WARN', code: 1, ratio, reason: `native WETH ${nativeWeth.toFixed(4)} below live floor ${LIVE_FLOOR_WETH} — deepen before enabling` };
  if (ratio < WARN_RATIO) return { status: 'WARN', code: 1, ratio, reason: `arb venue depth ${ratio.toFixed(2)}x < ${WARN_RATIO}x native — react before HALT` };
  return { status: 'GO', code: 0, ratio, reason: `arb linkage healthy (${ratio.toFixed(2)}x)` };
}

async function main() {
  const [native, uni] = await Promise.all([wethDepth(NATIVE_PAIR), wethDepth(UNISWAP_PAIR)]);
  const d = decide(native.wethEth, uni.wethEth);
  const out = {
    status: d.status,
    ratio: d.ratio ? Number(d.ratio.toFixed(3)) : null,
    nativeWethEth: Number(native.wethEth.toFixed(6)),
    uniswapWethEth: Number(uni.wethEth.toFixed(6)),
    haltRatio: HALT_RATIO,
    warnRatio: WARN_RATIO,
    liveFloorWeth: LIVE_FLOOR_WETH,
    reason: d.reason,
    at: new Date().toISOString(),
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(out));
  } else {
    const tag = { GO: '✅ GO', WARN: '⚠️  WARN', HALT: '🛑 HALT' }[d.status];
    console.log(`${tag}  — ${d.reason}`);
    console.log(`  native pool WETH : ${out.nativeWethEth}`);
    console.log(`  uniswap pool WETH: ${out.uniswapWethEth}`);
    console.log(`  ratio (uni/native): ${out.ratio ?? 'n/a'}  (halt<${HALT_RATIO}x, warn<${WARN_RATIO}x)`);
  }
  // Set exitCode + let the (now handle-free) loop drain naturally — avoids the
  // process.exit()/libuv close race that crashes on Windows.
  process.exitCode = d.code;
}

main().catch((e) => {
  // Fail LOUD: an unreachable monitor must not read as "healthy".
  if (JSON_OUT) console.log(JSON.stringify({ status: 'ERROR', reason: String(e.message || e), at: new Date().toISOString() }));
  else console.error(`🛑 monitor ERROR (treat as HALT): ${e.message || e}`);
  process.exitCode = 2;
});
