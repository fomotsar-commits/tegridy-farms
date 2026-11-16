// Live, read-only check against Ethereum mainnet. Skipped unless HOUSE_SIGNER_LIVE_RPC is set
// to an RPC URL (never printed: an endpoint is named by its host only).
//
// It runs the signer's real signBid path (request check, Seaport counter and code read over
// RPC, build, order check, sign, record) for a fresh test key, then asks Seaport 1.6 itself,
// by eth_call only:
//   - getOrderHash(components) must equal the signer's order hash;
//   - validate([order]) must accept the signature (it checks it with ecrecover, because the
//     caller is not the offerer and the test key has no code), and must reject a tampered one.
// Nothing is sent: eth_call runs against a copy of the state and changes nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChain } from '../src/chain.mjs';
import { createSigner } from '../src/signer.mjs';
import {
  componentsTuple, encodeCall, ORDER, ORDER_COMPONENTS, SIGNATURES, stringAt, wordAt, addressAt,
} from '../src/abi.mjs';
import { domainSeparator } from '../src/eip712.mjs';
import { fromJsonParameters } from '../src/order.mjs';
import { CONDUIT_CONTROLLER, OPENSEA_CONDUIT, OPENSEA_CONDUIT_KEY, SEAPORT } from '../src/constants.mjs';
import { addressOf } from '../src/sign.mjs';
import { buildFor, makePolicy, tempDir, testKey } from './support/helpers.mjs';

const RPC = process.env.HOUSE_SIGNER_LIVE_RPC;
const skip = RPC ? false : 'set HOUSE_SIGNER_LIVE_RPC to an Ethereum mainnet RPC to run the live check';
const KEY = testKey(1);
const ADDRESS = addressOf(KEY);

test('live: Seaport 1.6 getOrderHash equals the signer\'s order hash, and validate accepts its signature', { skip, timeout: 120_000 }, async (t) => {
  const chain = createChain({ readUrls: [RPC], sendUrls: [] });

  assert.equal(await chain.chainId(), 1n, 'the endpoint is Ethereum mainnet');
  const code = await chain.code(ADDRESS);
  assert.equal(code, '0x', 'the test key has no code (no EIP-7702 delegation), so Seaport checks it with ecrecover');
  t.diagnostic(`test key ${ADDRESS} (keccak256("house-bidder test key 1")), code 0x`);

  // Seaport 1.6 itself: version and domain separator.
  const info = await chain.call(SEAPORT, encodeCall(SIGNATURES.information, [], []));
  assert.equal(stringAt(info, 0), '1.6');
  assert.equal(`0x${wordAt(info, 1).toString(16).padStart(64, '0')}`, domainSeparator());
  t.diagnostic(`Seaport information(): version 1.6, domainSeparator ${domainSeparator()}`);

  // The conduit key resolves to the OpenSea conduit.
  const conduit = await chain.call(CONDUIT_CONTROLLER, encodeCall(SIGNATURES.getConduit, ['bytes32'], [OPENSEA_CONDUIT_KEY]));
  assert.equal(addressAt(conduit, 0), OPENSEA_CONDUIT);
  assert.equal(wordAt(conduit, 1), 1n);
  t.diagnostic(`ConduitController.getConduit(OpenSea key) = ${OPENSEA_CONDUIT}, exists`);

  // The real signBid path, as the bot would call it, for the test key as the house.
  const policy = makePolicy((p) => { p.house = ADDRESS; });
  const signer = createSigner({
    privateKey: KEY, policy, policySha256: 'live', keysDir: tempDir('live'), chain, sendUrls: [], mode: 'dev', watch: false,
  });
  const now = Math.floor(Date.now() / 1000);
  const bid = await signer.handle({
    id: 'live-1', op: 'signBid', slug: 'junglebay', qty: 2, unitPriceWei: '10000000000000000', startTime: now, endTime: now + 600, build: buildFor({ qty: 2, recipient: ADDRESS }),
  });
  assert.equal(bid.ok, true, `${bid.field}: ${bid.reason}`);
  t.diagnostic(`signBid: orderHash ${bid.orderHash}, counter ${bid.counter}, ${bid.parameters.consideration.length} consideration lines`);

  const components = fromJsonParameters(bid.parameters);
  const onChainHash = await chain.call(SEAPORT, encodeCall(SIGNATURES.getOrderHash, [ORDER_COMPONENTS], [componentsTuple(components)]));
  assert.equal(onChainHash, bid.orderHash, 'Seaport getOrderHash equals the signer\'s order hash');
  t.diagnostic(`Seaport getOrderHash = ${onChainHash} (equal)`);

  const parameters = componentsTuple(components, BigInt(components.consideration.length));
  const validated = await chain.call(SEAPORT, encodeCall(SIGNATURES.validate, [{ array: ORDER }], [[[parameters, bid.signature]]]));
  assert.equal(wordAt(validated, 0), 1n, 'validate([order]) returned true');
  t.diagnostic('Seaport validate([order]) via eth_call = true');

  // Negative control: the same order with one bit of the signature changed must be refused,
  // so the acceptance above is Seaport checking the signature, not ignoring it.
  const bad = `${bid.signature.slice(0, 10)}${bid.signature[10] === '0' ? '1' : '0'}${bid.signature.slice(11)}`;
  await assert.rejects(chain.call(SEAPORT, encodeCall(SIGNATURES.validate, [{ array: ORDER }], [[[parameters, bad]]])), (e) => e.kind === 'rpc');
  t.diagnostic('Seaport validate with a tampered signature: reverted (as it must)');
});
