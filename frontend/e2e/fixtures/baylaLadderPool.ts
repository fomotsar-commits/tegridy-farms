// Written by scripts/record-bayla-ladder-fixture.mjs. Do not edit by hand: run it again.
// The BAYLA lock ladder as mainnet answered on 2026-10-01T03:24:46.533Z, at slot 452165628.
// Keyed "<method>:<first param>"; each value is the JSON-RPC result exactly as received.
export const BAYLA_LADDER_RECORDING = {
  pool: "Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV",
  slot: 452165628,
  answers: {
    "getAccountInfo:Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV": {
      "context": {
        "apiVersion": "4.3.0",
        "slot": 452165627
      },
      "value": {
        "data": [
          "8ZptBBGxbbz9AGOXqlJul9FDfGHf+VZIG9qUaE+1xnVBhGM+WDQx51D/Bt324e51j94YQl285GzN2rYa/E2DuQ0n/r35KNihi/wG5RzcP+nluBHJqJLzyHWS4nkruBAbEqhA751Odhy38UgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANTvLySYlPGlvDhwh7qfsfFPvqAr4gbINycHgSLdRP3GLCDGdq9Y0PyLzxaHKz9tt5jwN2J8dgQ3OTamawhNs0gA4fUFAAAAAEAsJTJOhgMAAAAAAAAAAAAAAAAAAAAAAAAgSqnRAQAA4ILQBSAKAADemjTK5xIAAAAAAAAAAAAAVAEEAAAAAAAAAAAAAAAAAIDpK2sAAAAAsq67agAAAABdXNRwBgAAAAAAAAAAAAAA42yuIBoAAAAAAAAAAAAAAObT0ykDAAAAAAAAAAAAAAAAIl+h2wEAAAAAAAAAAAAA736zPgAAAAAAAAAAAAAAAAAAAAAAAAAAAFJbR2tBBwAAAAAAAAAAAACuJOE5BQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
          "base64"
        ],
        "executable": false,
        "lamports": 3230880,
        "owner": "EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ",
        "rentEpoch": 18446744073709552000,
        "space": 508
      }
    },
    "getTokenAccountBalance:FLCy81my7vNEaiqeFH7F1tk2aPR4Gcg8XSCFTvxWVps7": {
      "context": {
        "apiVersion": "4.3.0",
        "slot": 452165627
      },
      "value": {
        "amount": "11132652782304",
        "decimals": 6,
        "uiAmount": 11132652.782304,
        "uiAmountString": "11132652.782304"
      }
    },
    "getTokenAccountBalance:3yFvfhdRS9WNJEwVec7fgB3KRcKAi7Lo4jUyzzDMPAK1": {
      "context": {
        "apiVersion": "4.3.0",
        "slot": 452165628
      },
      "value": {
        "amount": "2030482132745",
        "decimals": 6,
        "uiAmount": 2030482.132745,
        "uiAmountString": "2030482.132745"
      }
    }
  },
} as const;
