// OpenSea `fulfillment_data` responses in the shape the proxy returns them:
// a Seaport function signature with unnamed tuple parameters, and an
// `input_data` object whose key order is the struct's field order (that order
// is what api.js falls back to when the signature carries no names).
//
// The NFT a fill moves is decided by what gets ENCODED, i.e. `input_data`,
// never by the advisory `orders` array beside it. These builders let a test
// put a venue token in one place and a foreign one in the other.

export const SEAPORT_15 = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";
export const SEAPORT_16 = "0x0000000000000068F116a894984e2DB1123eB395";
export const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = "0x" + "0".repeat(64);
const CONDUIT_KEY = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000";

const BASIC_SIG =
  "fulfillBasicOrder_efficient_6GL6yc((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))";

function basicParameters({ considerationToken, considerationIdentifier, considerationAmount, offerToken, offerIdentifier, offerAmount, basicOrderType }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    considerationToken,
    considerationIdentifier,
    considerationAmount,
    offerer: "0x" + "c".repeat(40),
    zone: ZERO,
    offerToken,
    offerIdentifier,
    offerAmount,
    basicOrderType,
    startTime: String(now - 60),
    endTime: String(now + 3600),
    zoneHash: ZERO32,
    salt: "1",
    offererConduitKey: CONDUIT_KEY,
    fulfillerConduitKey: CONDUIT_KEY,
    totalOriginalAdditionalRecipients: "0",
    additionalRecipients: [],
    signature: "0x",
  };
}

/**
 * A listing buy: ETH_TO_ERC721_FULL_OPEN (basicOrderType 0). The NFT is the
 * OFFER token. `ordersToken`, when given, is what the advisory `orders` array
 * claims, so a test can make it disagree with the calldata.
 */
export function buyFulfillment(nftToken, { tokenId = "7", ordersToken = null, to = SEAPORT_16 } = {}) {
  const out = {
    fulfillment_data: {
      transaction: {
        to,
        value: "100000000000000000",
        function: BASIC_SIG,
        input_data: {
          parameters: basicParameters({
            considerationToken: ZERO,
            considerationIdentifier: "0",
            considerationAmount: "100000000000000000",
            offerToken: nftToken,
            offerIdentifier: tokenId,
            offerAmount: "1",
            basicOrderType: 0,
          }),
        },
      },
    },
  };
  if (ordersToken) {
    out.fulfillment_data.orders = [{ parameters: { offer: [{ itemType: 2, token: ordersToken, identifierOrCriteria: tokenId }] } }];
  }
  return out;
}

/**
 * Accepting an item offer: ERC721_TO_ERC20_FULL_OPEN (basicOrderType 16). The
 * offerer pays WETH, and the NFT the seller hands over is the CONSIDERATION token.
 */
export function acceptFulfillment(nftToken, { tokenId = "7", to = SEAPORT_16 } = {}) {
  return {
    fulfillment_data: {
      transaction: {
        to,
        value: "0",
        function: BASIC_SIG,
        input_data: {
          parameters: basicParameters({
            considerationToken: nftToken,
            considerationIdentifier: tokenId,
            considerationAmount: "1",
            offerToken: WETH,
            offerIdentifier: "0",
            offerAmount: "50000000000000000",
            basicOrderType: 16,
          }),
        },
      },
    },
  };
}

/** A full `fulfillOrder` whose order offers `nftToken` (itemType 2). */
export function fulfillOrderFulfillment(nftToken, { tokenId = "7", to = SEAPORT_16 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    fulfillment_data: {
      transaction: {
        to,
        value: "100000000000000000",
        function:
          "fulfillOrder(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),bytes),bytes32)",
        input_data: {
          order: {
            parameters: {
              offerer: "0x" + "c".repeat(40),
              zone: ZERO,
              offer: [{ itemType: 2, token: nftToken, identifierOrCriteria: tokenId, startAmount: "1", endAmount: "1" }],
              consideration: [{ itemType: 0, token: ZERO, identifierOrCriteria: "0", startAmount: "100000000000000000", endAmount: "100000000000000000", recipient: "0x" + "c".repeat(40) }],
              orderType: 0,
              startTime: String(now - 60),
              endTime: String(now + 3600),
              zoneHash: ZERO32,
              salt: "1",
              conduitKey: CONDUIT_KEY,
              totalOriginalConsiderationItems: "1",
            },
            signature: "0x",
          },
          fulfillerConduitKey: CONDUIT_KEY,
        },
      },
    },
  };
}

/** An allowlisted function name whose arguments name no NFT at all. */
export function opaqueFulfillment({ to = SEAPORT_16 } = {}) {
  return {
    fulfillment_data: {
      transaction: { to, value: "0", function: "fulfillOrder(uint256 hint)", input_data: { hint: 1 } },
    },
  };
}
