// Every address, key and number the signer will ever sign for, written down once.
//
// Nothing here comes from the bot, from OpenSea or from policy.json. The policy can only
// narrow these (a lower price ceiling, a smaller quantity, a collection switched off); it
// can never point the house at a different contract, fee recipient or chain. Changing a
// value here is a code change, which means a reviewed commit and a new HOUSE_PIN_COMMIT.
//
// Sources (all read live 2026-11-15, see BUILD-SPEC section 1): Seaport 1.6 and its EIP-712
// domain, OpenSea's SignedZone, conduit and fee recipient (they match opensea-js
// src/constants.ts), WETH, and the two collections with their optional creator fees.

export const CHAIN_ID = 1n;

// Seaport 1.6. Its EIP-712 domain is { name: "Seaport", version: "1.6", chainId, this address }.
export const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
export const SEAPORT_NAME = 'Seaport';
export const SEAPORT_VERSION = '1.6';

// OpenSea's SignedZone ("offer protection"): OpenSea co-signs each fill, so a bid cannot be
// filled with an item OpenSea has flagged. Bids are restricted orders under this zone.
export const SIGNED_ZONE = '0x000056f7000000ece9003ca63978907a00ffd100';

// OpenSea's conduit and the key Seaport resolves it from. The conduit is the only spender the
// house ever approves, for WETH and for NFTs.
export const OPENSEA_CONDUIT = '0x1e0049783f008a0085193e00003d00cd54003c71';
export const OPENSEA_CONDUIT_KEY = '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000';
export const CONDUIT_CONTROLLER = '0x00000000f9490004c11cef243f5400493c00ad63';

// OpenSea's required marketplace fee: 1% to this address, on every bid.
export const OPENSEA_FEE_RECIPIENT = '0x0000a26b00c1f0df003000390027140000faa719';
export const OPENSEA_FEE_BPS = 100n;

export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

// The venue's fee Safe (2-of-2) and the venue fee. A venue line on a bid is only ever paid here.
export const VENUE_SAFE = '0x7d2620243edad69ec81a53c4a063b07995a4bd7d';
export const VENUE_FEE_BPS = 50n;

// The collections the house may bid on, keyed by OpenSea slug. A policy entry must name the
// same address; a creator fee, when the policy adds one, must go to the creator's own
// recipient and may not be more than the collection's optional fee.
export const KNOWN_COLLECTIONS = Object.freeze({
  junglebay: Object.freeze({
    address: '0xd37264c71e9af940e49795f0d3a8336afaafdda9',
    ticker: 'JBAC',
    creatorRecipient: '0xa3cc58eaa3800dc163726e031a2da49a9bb64eb3',
    creatorMaxBps: 700n,
  }),
  gnssart: Object.freeze({
    address: '0xa1de9f93c56c290c48849b1393b09eb616d55dbb',
    ticker: 'GNSS',
    creatorRecipient: '0x209aa937ac59f60384a70b98fec5daf54ac7b967',
    creatorMaxBps: 500n,
  }),
});

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

// Price tick shared by the site, the signer and the bot: a unit price is a whole number of
// 0.00001 ETH. Then unit x qty and (unit x qty) x bps / 10000 are whole numbers that divide
// exactly by qty, which Seaport needs for a partial fill of 1/qty to pay every line exactly.
export const PRICE_TICK_WEI = 10n ** 13n;
export const BPS_DENOMINATOR = 10_000n;

// Seaport item and order types.
export const ITEM = Object.freeze({
  NATIVE: 0,
  ERC20: 1,
  ERC721: 2,
  ERC1155: 3,
  ERC721_WITH_CRITERIA: 4,
  ERC1155_WITH_CRITERIA: 5,
});
export const ORDER_TYPE = Object.freeze({
  FULL_OPEN: 0,
  PARTIAL_OPEN: 1,
  FULL_RESTRICTED: 2,
  PARTIAL_RESTRICTED: 3,
});

// A bid's start time may differ from the signer's clock by at most this much.
export const START_TIME_SKEW_SEC = 300;

// After a transaction is sent, it is re-sent every block until it is mined or this long passes.
export const BROADCAST_WINDOW_MS = 180_000;

// Normal transactions leave this share of the fee cap unused, so a kill (which may spend the
// whole cap) always out-prices them by more than the 10% a node needs to accept a replacement.
export const NORMAL_FEE_SHARE_NUM = 8n;
export const NORMAL_FEE_SHARE_DEN = 10n;

// The most orders one on-chain cancel may carry; more would not fit under the gas limit.
export const MAX_CANCEL_ORDERS = 6;
