// Two OpenSea `fulfillment_data` answers captured 2026-10-25 from the live API
// (build-only endpoints: nothing was signed or sent). Every value here is public
// on-chain data. They are the shapes a real fill takes, so a guard that refuses
// either of them would refuse real trades.
//
//   LIVE_BUY     the cheapest Nakamigos listing (#4168) built for buyer LIVE_BUYER:
//                fulfillAdvancedOrder, all-ETH consideration, value = price.
//   LIVE_ACCEPT  the best collection offer on Nakamigos #1, built for its holder
//                LIVE_SELLER: matchAdvancedOrders with the seller's own counter-order.

export const LIVE_BUYER = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
export const LIVE_SELLER = "0xc320cdac341c7a4df5d5b27b88aea1bfd578ca9b";
export const LIVE_TOKEN_SOLD = "1";

export const LIVE_LISTING = {
  "order_hash": "0x136cf9e86df26c67e6b98cc77947f5d3886f4ec6dd13ff86ffedb7090fea3d10",
  "protocol_address": "0x0000000000000068f116a894984e2db1123eb395",
  "price": {
    "current": {
      "currency": "ETH",
      "decimals": 18,
      "value": "91099999999999000"
    }
  },
  "protocol_data": {
    "parameters": {
      "offerer": "0x4b6ca6713db92add6affef9da1b52933cd3f0913",
      "offer": [
        {
          "itemType": 2,
          "token": "0xd774557b647330c91bf44cfeab205095f7e6c367",
          "identifierOrCriteria": "4168",
          "startAmount": "1",
          "endAmount": "1"
        }
      ],
      "consideration": [
        {
          "itemType": 0,
          "token": "0x0000000000000000000000000000000000000000",
          "identifierOrCriteria": "0",
          "startAmount": "90188999999999010",
          "endAmount": "90188999999999010",
          "recipient": "0x4b6ca6713db92add6affef9da1b52933cd3f0913"
        },
        {
          "itemType": 0,
          "token": "0x0000000000000000000000000000000000000000",
          "identifierOrCriteria": "0",
          "startAmount": "910999999999990",
          "endAmount": "910999999999990",
          "recipient": "0x0000a26b00c1f0df003000390027140000faa719"
        }
      ],
      "endTime": "1793012438"
    }
  }
};

export const LIVE_BUY = {
  "to": "0x0000000000000068f116a894984e2db1123eb395",
  "value": "91099999999999000",
  "function": "fulfillAdvancedOrder(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),uint120,uint120,bytes,bytes),(uint256,uint8,uint256,uint256,bytes32[])[],bytes32,address)",
  "input_data": {
    "advancedOrder": {
      "parameters": {
        "offerer": "0x4b6ca6713db92add6affef9da1b52933cd3f0913",
        "zone": "0x000056f7000000ece9003ca63978907a00ffd100",
        "offer": [
          {
            "itemType": 2,
            "token": "0xd774557b647330c91bf44cfeab205095f7e6c367",
            "identifierOrCriteria": "4168",
            "startAmount": "1",
            "endAmount": "1"
          }
        ],
        "consideration": [
          {
            "itemType": 0,
            "token": "0x0000000000000000000000000000000000000000",
            "identifierOrCriteria": "0",
            "startAmount": "90188999999999010",
            "endAmount": "90188999999999010",
            "recipient": "0x4b6ca6713db92add6affef9da1b52933cd3f0913"
          },
          {
            "itemType": 0,
            "token": "0x0000000000000000000000000000000000000000",
            "identifierOrCriteria": "0",
            "startAmount": "910999999999990",
            "endAmount": "910999999999990",
            "recipient": "0x0000a26b00c1f0df003000390027140000faa719"
          }
        ],
        "orderType": 3,
        "startTime": "1792969238",
        "endTime": "1793012438",
        "zoneHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "salt": "10536123635643352385",
        "conduitKey": "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
        "totalOriginalConsiderationItems": "2"
      },
      "numerator": 1,
      "denominator": 1,
      "signature": "0xe1af186793609c5cc704958d70c7b02462a748fcddeefe22cb181c249b791a65c821e026685f6c6133c014b6b00a195dd73f00a5ffb1c780efa412fc97759431",
      "extraData": "0x00d8da6bf26964af9d7eed9e03e53415d37aa96045000000006adea406f161b782f1c8bbf2889820e8fb074b9693e5f5d0e64f38280b1e529419e4af73e0dd2e03fa5f10d8be24d7d8e89b5946930a6d0146ad41122b1fadf94a6489ff000000000000000000000000000000000000000000000000000000000000000000"
    },
    "criteriaResolvers": [],
    "fulfillerConduitKey": "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
    "recipient": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045"
  }
};

export const LIVE_ACCEPT = {
  "to": "0x0000000000000068f116a894984e2db1123eb395",
  "value": "0",
  "function": "matchAdvancedOrders(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),uint120,uint120,bytes,bytes)[],(uint256,uint8,uint256,uint256,bytes32[])[],((uint256,uint256)[],(uint256,uint256)[])[],address)",
  "input_data": {
    "orders": [
      {
        "parameters": {
          "offerer": "0x994b470248b6f9bbede09422a15990efdb793096",
          "zone": "0x000056f7000000ece9003ca63978907a00ffd100",
          "offer": [
            {
              "itemType": 1,
              "token": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
              "identifierOrCriteria": "0",
              "startAmount": "84200000000000000",
              "endAmount": "84200000000000000"
            }
          ],
          "consideration": [
            {
              "itemType": 4,
              "token": "0xd774557b647330c91bf44cfeab205095f7e6c367",
              "identifierOrCriteria": "0",
              "startAmount": "1",
              "endAmount": "1",
              "recipient": "0x994b470248b6f9bbede09422a15990efdb793096"
            },
            {
              "itemType": 1,
              "token": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
              "identifierOrCriteria": "0",
              "startAmount": "842000000000000",
              "endAmount": "842000000000000",
              "recipient": "0x0000a26b00c1f0df003000390027140000faa719"
            }
          ],
          "orderType": 2,
          "startTime": "1792975191",
          "endTime": "1792975911",
          "zoneHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
          "salt": "51951570786726798460324975021501917861654789585098516727715900175853578600768",
          "conduitKey": "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
          "totalOriginalConsiderationItems": "2"
        },
        "numerator": 1,
        "denominator": 1,
        "signature": "0x3b19bef8db5df62cc4c894fa9848d2df2c4be125b83b3d062b9a69d8355d18792d26969120ac95ba4c8316202981cb73c7369d5511e90f311182733d422ad8c31c",
        "extraData": "0x00c320cdac341c7a4df5d5b27b88aea1bfd578ca9b000000006adea40a10115181a4b5e50abe481283946573fe951e02e619ab692ef3050369b7845cd66d05d67fd757f24b4018fc5b186f7201dcc46e5692c15b065d1a61284b0279cf000000000000000000000000000000000000000000000000000000000000000001"
      },
      {
        "parameters": {
          "offerer": "0xc320cdac341c7a4df5d5b27b88aea1bfd578ca9b",
          "zone": "0x0000000000000000000000000000000000000000",
          "offer": [
            {
              "itemType": 2,
              "token": "0xd774557b647330c91bf44cfeab205095f7e6c367",
              "identifierOrCriteria": "1",
              "startAmount": "1",
              "endAmount": "1"
            }
          ],
          "consideration": [
            {
              "itemType": 1,
              "token": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
              "identifierOrCriteria": "0",
              "startAmount": "83358000000000000",
              "endAmount": "83358000000000000",
              "recipient": "0xc320cdac341c7a4df5d5b27b88aea1bfd578ca9b"
            }
          ],
          "orderType": 0,
          "startTime": "1792975191",
          "endTime": "1792975911",
          "zoneHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
          "salt": "27855337018906766782546881864045825683096516384821792734247272408012915349243",
          "conduitKey": "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
          "totalOriginalConsiderationItems": "1"
        },
        "numerator": 1,
        "denominator": 1,
        "signature": "0x",
        "extraData": "0x"
      }
    ],
    "criteriaResolvers": [
      {
        "orderIndex": "0",
        "side": 1,
        "index": "0",
        "identifier": "1",
        "criteriaProof": []
      }
    ],
    "fulfillments": [
      {
        "offerComponents": [
          {
            "orderIndex": "1",
            "itemIndex": "0"
          }
        ],
        "considerationComponents": [
          {
            "orderIndex": "0",
            "itemIndex": "0"
          }
        ]
      },
      {
        "offerComponents": [
          {
            "orderIndex": "0",
            "itemIndex": "0"
          }
        ],
        "considerationComponents": [
          {
            "orderIndex": "0",
            "itemIndex": "1"
          }
        ]
      },
      {
        "offerComponents": [
          {
            "orderIndex": "0",
            "itemIndex": "0"
          }
        ],
        "considerationComponents": [
          {
            "orderIndex": "1",
            "itemIndex": "0"
          }
        ]
      }
    ],
    "recipient": "0xc320cdac341c7a4df5d5b27b88aea1bfd578ca9b"
  }
};
