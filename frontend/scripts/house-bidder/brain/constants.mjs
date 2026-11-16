// The house bidder's fixed facts (BUILD-SPEC section 1, each read live on 2026-11-15).
//
// Everything here is lowercased: every comparison the bot makes is on lowercased addresses,
// so a checksummed copy in a file can never miss a match by case. These are the same pins the
// signer holds (tools/house-signer); the bot checks them too, so a bad build or a bad answer is
// caught before it ever reaches the signer, and again after the signer answers.

export const CHAIN_ID = 1;

/** Seaport 1.6: every house bid is an order on this contract (EIP-712 domain "Seaport" / "1.6"). */
export const SEAPORT_16 = '0x0000000000000068f116a894984e2db1123eb395';
export const SEAPORT_DOMAIN = Object.freeze({ name: 'Seaport', version: '1.6', chainId: CHAIN_ID, verifyingContract: SEAPORT_16 });

/** OpenSea's protection zone. A bid behind it can be cancelled without gas, and OpenSea refuses to co-sign fills of items it flags. */
export const SIGNED_ZONE = '0x000056f7000000ece9003ca63978907a00ffd100';
export const OPENSEA_CONDUIT = '0x1e0049783f008a0085193e00003d00cd54003c71';
export const OPENSEA_CONDUIT_KEY = '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000';
/** OpenSea's fee: 1%, required on both collections, paid out of the bid (the seller nets 99%). */
export const OPENSEA_FEE = Object.freeze({ recipient: '0x0000a26b00c1f0df003000390027140000faa719', bps: 100 });
export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

/** The only two collections v1 knows. A slug outside this list is refused everywhere. */
export const COLLECTIONS = Object.freeze({
  junglebay: Object.freeze({ address: '0xd37264c71e9af940e49795f0d3a8336afaafdda9', ticker: 'JBAC' }),
  gnssart: Object.freeze({ address: '0xa1de9f93c56c290c48849b1393b09eb616d55dbb', ticker: 'GNSS' }),
});

/** The venue fee Safe (treasury, 2-of-2) and its fee. */
export const VENUE_FEE_SAFE = '0x7d2620243edad69ec81a53c4a063b07995a4bd7d';
export const VENUE_FEE_BPS = 50;

/**
 * Venue contracts that must never trade with the house, whatever insiders.json says: the
 * treasury Safe, the Gondi loan contract, its liquidator and the JBAC staking vault
 * (BUILD-SPEC 2.2; addresses as in scripts/addresses.json). insiders.json adds to this list,
 * it can never take one away.
 */
export const VENUE_CONTRACTS = Object.freeze([
  VENUE_FEE_SAFE,
  '0x4f2b53dae3edcf1b527c53d2c11a28ec5ac6d630', // Gondi loan contract
  '0xe61613035b85308f31e068bbc31257524ffe7fa6', // Gondi liquidator
  '0x28317bf362d43b40fcecebf2390c43db558c3f14', // JBAC staking vault
]);

/**
 * People who must never trade with the house, whatever insiders.json says: the treasury Safe's
 * two signers and the venue's operator wallet (all public in scripts/addresses.json). A collection
 * bid cannot choose who sells into it, so the fill monitor checks every seller against this list
 * plus insiders.json. Forgetting a line in a file must not be how an insider gets paid.
 */
export const BUILT_IN_INSIDERS = Object.freeze([
  '0x28d7cb2f4d73c2750ba0055c771871fec79260f8', // treasury Safe signer
  '0xe9b7ab8e367be5ac0e0c865136f1907bd73df53e', // treasury Safe signer (greencifer.eth)
  '0x14898258122c0740106391e6e8e4f17f3b6d456e', // venue operator / deployer
]);

/** A unit price in wei is a multiple of this (0.00001 ETH), so every fee line divides by any quantity. */
export const PRICE_TICK_WEI = 10n ** 13n;
export const ZERO32 = `0x${'0'.repeat(64)}`;
export const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
export const ONE_ETH = 10n ** 18n;

export const ITEM = Object.freeze({ NATIVE: 0, ERC20: 1, ERC721: 2, ERC1155: 3, ERC721_WITH_CRITERIA: 4, ERC1155_WITH_CRITERIA: 5 });
export const ORDER = Object.freeze({ FULL_OPEN: 0, PARTIAL_OPEN: 1, FULL_RESTRICTED: 2, PARTIAL_RESTRICTED: 3 });

/** How long an OpenSea fill signature issued before a gasless cancel can still be used (the "tail"). */
export const GASLESS_TAIL_SEC = 5 * 60;

/**
 * The signer's daily budget when policy.json names none: 20 transactions and 0.05 ETH of gas in
 * any 24 hours (tools/house-signer, policy.mjs DEFAULT_DAILY; the kill is never counted). The bot
 * plans no more than that, or the signer refuses a transaction and the refusal halts the bot.
 */
export const SIGNER_DAILY_DEFAULT = Object.freeze({ maxTxs: 20, maxGasWei: 50_000_000_000_000_000n });
/** The lowest gas.maxGasLimit the signer accepts: what an on-chain cancel of 6 orders needs (its MAX_TX_GAS). */
export const SIGNER_MIN_GAS_LIMIT = 255_000;

/** Seaport's EIP-712 types (unchanged since 1.1). The bot only ever uses them to CHECK a signature. */
export const SEAPORT_TYPES = Object.freeze({
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
});
