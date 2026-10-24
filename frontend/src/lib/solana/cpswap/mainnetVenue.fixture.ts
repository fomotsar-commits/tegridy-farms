// Written by scripts/record-pools-venue-fixture.mjs. Do not edit by hand: run it again.
// What /pools reads on load, as mainnet answered on 2026-10-03T03:25:30.236Z, at slot 452811560.
// Keyed "<method>:<first param>"; each value is the JSON-RPC result exactly as received
// (ProgramData through a 45-byte dataSlice: the probe reads only that it exists).
export const MAINNET_VENUE_RECORDING = {
  slot: 452811560,
  program: "EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT",
  programData: "F475omgJMd5mnDXJFyjHTkg9zs7WSb6ek9dFoUmUvi5V",
  tier0: "BHMteE8u6LAppswQmFmd2h7hp1fCfWtGahvVJnhRk8jW",
  tier1: "CapqvAA9HvERTwzmE26xrtFhMaNcaXXoQUADpBWqWjKy",
  feeReceiver: "2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa",
  answers: {
    "getAccountInfo:EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT": {
      "context": {
        "apiVersion": "4.3.0",
        "slot": 452811559
      },
      "value": {
        "data": [
          "AgAAANDPPMDatJ3yBmvL2a4x917ftUdLYfH6qaW+GwBWIEgA",
          "base64"
        ],
        "executable": true,
        "lamports": 833120,
        "owner": "BPFLoaderUpgradeab1e11111111111111111111111",
        "rentEpoch": 18446744073709552000,
        "space": 36
      }
    },
    "getAccountInfo:F475omgJMd5mnDXJFyjHTkg9zs7WSb6ek9dFoUmUvi5V": {
      "context": {
        "apiVersion": "4.3.0",
        "slot": 452811559
      },
      "value": {
        "data": [
          "AwAAACI07BoAAAAAAeUc3D/p5bgRyaiS88h1kuJ5K7gQGxKoQO+dTnYct/FI",
          "base64"
        ],
        "executable": false,
        "lamports": 3514410040,
        "owner": "BPFLoaderUpgradeab1e11111111111111111111111",
        "rentEpoch": 18446744073709552000,
        "space": 691685
      }
    },
    "getAccountInfo:BHMteE8u6LAppswQmFmd2h7hp1fCfWtGahvVJnhRk8jW": {
      "context": {
        "apiVersion": "4.3.0",
        "slot": 452811559
      },
      "value": {
        "data": [
          "2vQhaMvLK2/9AAAAxAkAAAAAAABADQMAAAAAAAAAAAAAAAAAAAAAAAAAAADlHNw/6eW4EcmokvPIdZLieSu4EBsSqEDvnU52HLfxSOUc3D/p5bgRyaiS88h1kuJ5K7gQGxKoQO+dTnYct/FI9AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          "base64"
        ],
        "executable": false,
        "lamports": 1849120,
        "owner": "EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT",
        "rentEpoch": 18446744073709552000,
        "space": 236
      }
    },
    "getAccountInfo:CapqvAA9HvERTwzmE26xrtFhMaNcaXXoQUADpBWqWjKy": {
      "context": {
        "apiVersion": "4.3.0",
        "slot": 452811560
      },
      "value": {
        "data": [
          "2vQhaMvLK2//AAEAECcAAAAAAAAAcQIAAAAAAAAAAAAAAAAAgNHwCAAAAADlHNw/6eW4EcmokvPIdZLieSu4EBsSqEDvnU52HLfxSOUc3D/p5bgRyaiS88h1kuJ5K7gQGxKoQO+dTnYct/FIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          "base64"
        ],
        "executable": false,
        "lamports": 1849120,
        "owner": "EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT",
        "rentEpoch": 18446744073709552000,
        "space": 236
      }
    },
    "getAccountInfo:2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa": {
      "context": {
        "apiVersion": "4.3.0",
        "slot": 452811560
      },
      "value": {
        "data": [
          "BpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAHlHNw/6eW4EcmokvPIdZLieSu4EBsSqEDvnU52HLfxSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAADwHR8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          "base64"
        ],
        "executable": false,
        "lamports": 2039280,
        "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "rentEpoch": 18446744073709552000,
        "space": 165
      }
    },
    "getMultipleAccounts:BHMteE8u6LAppswQmFmd2h7hp1fCfWtGahvVJnhRk8jW,CapqvAA9HvERTwzmE26xrtFhMaNcaXXoQUADpBWqWjKy": {
      "context": {
        "apiVersion": "4.3.0",
        "slot": 452811560
      },
      "value": [
        {
          "data": [
            "2vQhaMvLK2/9AAAAxAkAAAAAAABADQMAAAAAAAAAAAAAAAAAAAAAAAAAAADlHNw/6eW4EcmokvPIdZLieSu4EBsSqEDvnU52HLfxSOUc3D/p5bgRyaiS88h1kuJ5K7gQGxKoQO+dTnYct/FI9AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "base64"
          ],
          "executable": false,
          "lamports": 1849120,
          "owner": "EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT",
          "rentEpoch": 18446744073709552000,
          "space": 236
        },
        {
          "data": [
            "2vQhaMvLK2//AAEAECcAAAAAAAAAcQIAAAAAAAAAAAAAAAAAgNHwCAAAAADlHNw/6eW4EcmokvPIdZLieSu4EBsSqEDvnU52HLfxSOUc3D/p5bgRyaiS88h1kuJ5K7gQGxKoQO+dTnYct/FIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "base64"
          ],
          "executable": false,
          "lamports": 1849120,
          "owner": "EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT",
          "rentEpoch": 18446744073709552000,
          "space": 236
        }
      ]
    },
    "getMinimumBalanceForRentExemption:637": 3886200,
    "getMinimumBalanceForRentExemption:4075": 21351240,
    "getMinimumBalanceForRentExemption:82": 1066800,
    "getMinimumBalanceForRentExemption:165": 1488440,
    "getGenesisHash:undefined": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
  },
} as const;
