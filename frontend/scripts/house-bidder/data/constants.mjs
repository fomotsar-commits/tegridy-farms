/**
 * Pinned addresses and event topics for the house bidder's data layer (BUILD-SPEC section 1, every
 * value read live on 2026-11-15/16). All lowercase, because every comparison in the bot is done on
 * lowercased addresses. These are READ pins: the data layer uses them to read and decode. What the
 * house may SIGN is pinned separately, in the signer (tools/house-signer), and never comes from here.
 */

/** Seaport 1.6: where every live bid on both books sits. */
export const SEAPORT_16 = '0x0000000000000068f116a894984e2db1123eb395';
/** The same address checksummed, as OpenSea's own SDK sends it in `protocol_address`. */
export const SEAPORT_16_CHECKSUMMED = '0x0000000000000068F116a894984e2DB1123eB395';
/** Seaport 1.5: still carries some older native listings. Read, never bid on. */
export const SEAPORT_15 = '0x00000000000000adc04c56bf30ac9d3c0aaf14dc';
/** OpenSea's SignedZone for Seaport 1.6 (fills need OpenSea's co-signature, so flagged items can't fill). */
export const SIGNED_ZONE = '0x000056f7000000ece9003ca63978907a00ffd100';
/** OpenSea's conduit: the operator a listing maker must approve, and the spender of a bidder's WETH. */
export const OPENSEA_CONDUIT = '0x1e0049783f008a0085193e00003d00cd54003c71';
export const OPENSEA_CONDUIT_KEY = '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000';
/** A conduit key of zero means "no conduit": the maker approves Seaport itself. */
export const NO_CONDUIT_KEY = '0x0000000000000000000000000000000000000000000000000000000000000000';
export const OPENSEA_FEE_RECIPIENT = '0x0000a26b00c1f0df003000390027140000faa719';

export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
/** Blur's pool token (BETH): ETH held for Blur bids, 1:1 with ETH. A sale paid in it was a bid being hit. */
export const BLUR_POOL = '0x0000000000a39bb272e79075ade125fd351887ac';
export const NATIVE = '0x0000000000000000000000000000000000000000';
export const ZERO_ADDRESS = NATIVE;
/** Multicall3, the same address on every chain viem knows; deployed on mainnet at block 14,353,601. */
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

/** The two collections the house may bid on, by OpenSea slug. */
export const COLLECTIONS = Object.freeze({
  junglebay: Object.freeze({ address: '0xd37264c71e9af940e49795f0d3a8336afaafdda9', ticker: 'JBAC' }),
  gnssart: Object.freeze({ address: '0xa1de9f93c56c290c48849b1393b09eb616d55dbb', ticker: 'GNSS' }),
});

/**
 * GNSS's contract source is not verified. Its mintTransfer() reads storage slot 0xd and lets the
 * address stored there mint (review-failure-modes/06-gnss-seed-mint.json). Whoever that "seed" is can
 * create new GNSS, so a change to it is an integrity breaker. It is read with eth_getStorageAt because
 * no view function returns it.
 */
export const GNSS_SEED_SLOT = '0x000000000000000000000000000000000000000000000000000000000000000d';

/** keccak256 of each event signature, checked live by viem's toEventSelector on 2026-11-16. */
export const TOPICS = Object.freeze({
  Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  OwnershipTransferred: '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0',
  OrderFulfilled: '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31',
});

/** Seconds per Ethereum slot. A block can be missed but never comes faster than this. */
export const SECONDS_PER_SLOT = 12;
