// Writes test/fixtures/viem-fixture.json: the answers viem gives for the exact hashes,
// signatures, calldata and transactions the signer produces, so the signer's own
// implementations (eip712.mjs, abi.mjs, tx.mjs) are checked against an independent one.
//
// Run once, by hand, from a checkout whose frontend/ has its dependencies installed:
//   node tools/house-signer/scripts/make-viem-fixture.mjs
// It borrows the frontend's viem through a require anchored at frontend/package.json. The
// signer itself never loads viem (it is not a dependency; this script is not part of it),
// and this file is not a test: node --test does not collect scripts/.
//
// Nothing here reads a secret. The keys are the public test keys every check in this
// project uses: keccak256("house-bidder test key <n>"). Amounts below are written out by
// hand, not computed by the signer's code.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const signerRoot = path.resolve(here, '..');
const repoRoot = path.resolve(signerRoot, '..', '..');
const require = createRequire(path.join(repoRoot, 'frontend', 'package.json'));
const viem = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const viemVersion = JSON.parse(fs.readFileSync(require.resolve('viem/package.json'), 'utf8')).version;

const { keccak256, toBytes, hashTypedData, hashStruct, hashDomain, encodeFunctionData, toFunctionSelector, serializeTransaction, getAddress } = viem;

const testKey = (n) => keccak256(toBytes(`house-bidder test key ${n}`));
const account1 = privateKeyToAccount(testKey(1));
const account2 = privateKeyToAccount(testKey(2));

const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395';
const SIGNED_ZONE = '0x000056F7000000EcE9003ca63978907a00FFD100';
const CONDUIT = '0x1E0049783F008A0085193E00003D00cd54003c71';
const CONDUIT_KEY = '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000';
const OS_FEE = '0x0000a26b00c1F0DF003000390027140000fAa719';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const JBAC = '0xd37264c71e9af940e49795F0d3a8336afAaFDdA9';
const GNSS = '0xa1De9f93c56C290C48849B1393b09eB616D55dbb';
const JBAC_CREATOR = '0xa3cc58eaa3800dc163726e031a2da49a9bb64eb3';
const GNSS_CREATOR = '0x209aa937ac59f60384a70b98fec5daf54ac7b967';
const VENUE_SAFE = '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d';
const FUNDING = '0x1111111111111111111111111111111111111111';

const domain = { name: 'Seaport', version: '1.6', chainId: 1, verifyingContract: SEAPORT };
const types = {
  OrderComponents: [
    { name: 'offerer', type: 'address' },
    { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' },
    { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
    { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' },
    { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' },
  ],
  OfferItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
};
const cancelTypes = { OrderHash: [{ name: 'orderHash', type: 'bytes32' }] };

const ZERO32 = `0x${'00'.repeat(32)}`;
const nft = (token, qty, recipient) => ({ itemType: 4, token, identifierOrCriteria: 0n, startAmount: qty, endAmount: qty, recipient });
const weth = (amount, recipient) => ({ itemType: 1, token: WETH, identifierOrCriteria: 0n, startAmount: amount, endAmount: amount, recipient });

// Each order: inputs as the signer receives them, and the components written out by hand.
const cases = [
  {
    name: 'jbac qty 1, OpenSea fee only',
    input: { slug: 'junglebay', qty: 1, unitPriceWei: '30000000000000000', startTime: 1763251200, endTime: 1763253000, salt: 0x5a17n, counter: 0n },
    policyFees: { creator: null, venue: false },
    offerer: account1.address,
    offerTotal: 30000000000000000n,
    consideration: [nft(JBAC, 1n, account1.address), weth(300000000000000n, OS_FEE)],
  },
  {
    name: 'jbac qty 2, OpenSea + creator 7% + venue 0.5%',
    input: { slug: 'junglebay', qty: 2, unitPriceWei: '40000000000000000', startTime: 1763251200, endTime: 1763253000, salt: 0xfeedfacecafebeef00112233445566778899aabbccddeeff0011223344556677n, counter: 340282366920938463463374607431768211461n },
    policyFees: { creator: 700, venue: true },
    offerer: account1.address,
    offerTotal: 80000000000000000n,
    consideration: [nft(JBAC, 2n, account1.address), weth(800000000000000n, OS_FEE), weth(5600000000000000n, JBAC_CREATOR), weth(400000000000000n, VENUE_SAFE)],
  },
  {
    name: 'gnss qty 1, OpenSea + creator 5%',
    input: { slug: 'gnssart', qty: 1, unitPriceWei: '12340000000000000', startTime: 1763251200, endTime: 1763251500, salt: 1n, counter: 7n },
    policyFees: { creator: 500, venue: false },
    offerer: account2.address,
    offerTotal: 12340000000000000n,
    consideration: [nft(GNSS, 1n, account2.address), weth(123400000000000n, OS_FEE), weth(617000000000000n, GNSS_CREATOR)],
  },
];

const s = (v) => (typeof v === 'bigint' ? v.toString() : v);
const itemJson = (i) => Object.fromEntries(Object.entries(i).map(([k, v]) => [k, s(v)]));

const OFFER_ITEM_ABI = { type: 'tuple', components: types.OfferItem.map((f) => ({ name: f.name, type: f.type })) };
const CONSIDERATION_ITEM_ABI = { type: 'tuple', components: types.ConsiderationItem.map((f) => ({ name: f.name, type: f.type })) };
const componentsAbi = (lastName) => [
  { name: 'offerer', type: 'address' },
  { name: 'zone', type: 'address' },
  { name: 'offer', type: 'tuple[]', components: OFFER_ITEM_ABI.components },
  { name: 'consideration', type: 'tuple[]', components: CONSIDERATION_ITEM_ABI.components },
  { name: 'orderType', type: 'uint8' },
  { name: 'startTime', type: 'uint256' },
  { name: 'endTime', type: 'uint256' },
  { name: 'zoneHash', type: 'bytes32' },
  { name: 'salt', type: 'uint256' },
  { name: 'conduitKey', type: 'bytes32' },
  { name: lastName, type: 'uint256' },
];
const abi = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'wad', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'incrementCounter', stateMutability: 'nonpayable', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'cancel', stateMutability: 'nonpayable', inputs: [{ name: 'orders', type: 'tuple[]', components: componentsAbi('counter') }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'safeTransferFrom', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'getCounter', stateMutability: 'view', inputs: [{ name: 'offerer', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getOrderHash', stateMutability: 'view', inputs: [{ name: 'order', type: 'tuple', components: componentsAbi('counter') }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'validate', stateMutability: 'nonpayable', inputs: [{ name: 'orders', type: 'tuple[]', components: [{ name: 'parameters', type: 'tuple', components: componentsAbi('totalOriginalConsiderationItems') }, { name: 'signature', type: 'bytes' }] }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'information', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }, { type: 'bytes32' }, { type: 'address' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getConduit', stateMutability: 'view', inputs: [{ name: 'conduitKey', type: 'bytes32' }], outputs: [{ type: 'address' }, { type: 'bool' }] },
];

const orders = [];
for (const c of cases) {
  const components = {
    offerer: c.offerer,
    zone: SIGNED_ZONE,
    offer: [{ itemType: 1, token: WETH, identifierOrCriteria: 0n, startAmount: c.offerTotal, endAmount: c.offerTotal }],
    consideration: c.consideration,
    orderType: 3,
    startTime: BigInt(c.input.startTime),
    endTime: BigInt(c.input.endTime),
    zoneHash: ZERO32,
    salt: c.input.salt,
    conduitKey: CONDUIT_KEY,
    counter: c.input.counter,
  };
  const account = c.offerer === account1.address ? account1 : account2;
  const orderHash = hashStruct({ data: components, primaryType: 'OrderComponents', types });
  const digest = hashTypedData({ domain, types, primaryType: 'OrderComponents', message: components });
  const signature = await account.signTypedData({ domain, types, primaryType: 'OrderComponents', message: components });
  const parameters = { ...components, totalOriginalConsiderationItems: BigInt(components.consideration.length) };
  delete parameters.counter;
  orders.push({
    name: c.name,
    input: { ...c.input, salt: s(c.input.salt), counter: s(c.input.counter) },
    policyFees: c.policyFees,
    components: {
      ...components,
      offer: components.offer.map(itemJson),
      consideration: components.consideration.map(itemJson),
      startTime: s(components.startTime),
      endTime: s(components.endTime),
      salt: s(components.salt),
      counter: s(components.counter),
    },
    orderHash,
    digest,
    signature,
    cancel: {
      digest: hashTypedData({ domain, types: cancelTypes, primaryType: 'OrderHash', message: { orderHash } }),
      signature: await account.signTypedData({ domain, types: cancelTypes, primaryType: 'OrderHash', message: { orderHash } }),
    },
    calldata: {
      getOrderHash: encodeFunctionData({ abi, functionName: 'getOrderHash', args: [components] }),
      validate: encodeFunctionData({ abi, functionName: 'validate', args: [[{ parameters, signature }]] }),
    },
  });
}

const all = cases.map((c, i) => ({ ...orders[i] }));
const cancelTwo = encodeFunctionData({
  abi,
  functionName: 'cancel',
  args: [cases.slice(0, 2).map((c) => ({
    offerer: c.offerer, zone: SIGNED_ZONE, offer: [{ itemType: 1, token: WETH, identifierOrCriteria: 0n, startAmount: c.offerTotal, endAmount: c.offerTotal }],
    consideration: c.consideration, orderType: 3, startTime: BigInt(c.input.startTime), endTime: BigInt(c.input.endTime), zoneHash: ZERO32, salt: c.input.salt, conduitKey: CONDUIT_KEY, counter: c.input.counter,
  }))],
});

const calls = {
  approveWeth: { amountWei: '150000000000000000', data: encodeFunctionData({ abi, functionName: 'approve', args: [CONDUIT, 150000000000000000n] }) },
  revokeWeth: { data: encodeFunctionData({ abi, functionName: 'approve', args: [CONDUIT, 0n] }) },
  wrap: { amountWei: '200000000000000000', data: encodeFunctionData({ abi, functionName: 'deposit', args: [] }) },
  unwrap: { amountWei: '1234500000000000', data: encodeFunctionData({ abi, functionName: 'withdraw', args: [1234500000000000n] }) },
  returnWethToFunding: { amountWei: '987000000000000', funding: FUNDING, data: encodeFunctionData({ abi, functionName: 'transfer', args: [FUNDING, 987000000000000n] }) },
  incrementCounter: { data: encodeFunctionData({ abi, functionName: 'incrementCounter', args: [] }) },
  cancelOnChain: { orders: [all[0].name, all[1].name], data: cancelTwo },
  setNftApprovalOff: { slug: 'junglebay', data: encodeFunctionData({ abi, functionName: 'setApprovalForAll', args: [CONDUIT, false] }) },
  setNftApprovalOn: { slug: 'junglebay', data: encodeFunctionData({ abi, functionName: 'setApprovalForAll', args: [CONDUIT, true] }) },
  returnNftToFunding: { slug: 'junglebay', tokenId: '4242', from: account1.address, funding: FUNDING, data: encodeFunctionData({ abi, functionName: 'safeTransferFrom', args: [account1.address, FUNDING, 4242n] }) },
  getCounter: { data: encodeFunctionData({ abi, functionName: 'getCounter', args: [account1.address] }) },
  balanceOf: { data: encodeFunctionData({ abi, functionName: 'balanceOf', args: [account1.address] }) },
  allowance: { data: encodeFunctionData({ abi, functionName: 'allowance', args: [account1.address, CONDUIT] }) },
};

const selectors = Object.fromEntries(abi.map((a) => [a.name, toFunctionSelector(a)]));

const txCases = [
  { name: 'approve WETH', tx: { chainId: 1, nonce: 0, maxPriorityFeePerGas: 50000000n, maxFeePerGas: 16000000000n, gas: 60000n, to: WETH, value: 0n, data: calls.approveWeth.data, type: 'eip1559' } },
  { name: 'wrap 0.2 ETH', tx: { chainId: 1, nonce: 7, maxPriorityFeePerGas: 50000000n, maxFeePerGas: 9876543210n, gas: 60000n, to: WETH, value: 200000000000000000n, data: calls.wrap.data, type: 'eip1559' } },
  { name: 'kill revoke at nonce 300', tx: { chainId: 1, nonce: 300, maxPriorityFeePerGas: 2000000000n, maxFeePerGas: 20000000000n, gas: 60000n, to: WETH, value: 0n, data: calls.revokeWeth.data, type: 'eip1559' } },
  { name: 'cancel two orders', tx: { chainId: 1, nonce: 12, maxPriorityFeePerGas: 1n, maxFeePerGas: 100n, gas: 115000n, to: SEAPORT, value: 0n, data: cancelTwo, type: 'eip1559' } },
];
const txs = [];
for (const t of txCases) {
  const unsigned = serializeTransaction(t.tx);
  const signed = await account1.signTransaction(t.tx);
  txs.push({ name: t.name, tx: Object.fromEntries(Object.entries(t.tx).filter(([k]) => k !== 'type').map(([k, v]) => [k, s(v)])), unsigned, signed, hash: keccak256(signed) });
}

const fixture = {
  generatedBy: `tools/house-signer/scripts/make-viem-fixture.mjs with viem ${viemVersion}`,
  testKeys: { 1: { label: 'house-bidder test key 1', address: account1.address }, 2: { label: 'house-bidder test key 2', address: account2.address } },
  domain,
  domainSeparator: hashDomain({ domain, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } }),
  orders,
  calls,
  selectors,
  txs,
  checksums: [SEAPORT, SIGNED_ZONE, CONDUIT, OS_FEE, WETH, JBAC, GNSS, VENUE_SAFE].map((a) => ({ lower: a.toLowerCase(), checksummed: getAddress(a) })),
};

const out = path.join(signerRoot, 'test', 'fixtures', 'viem-fixture.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
process.stdout.write(`wrote ${path.relative(repoRoot, out)} (viem ${viemVersion})\n`);
