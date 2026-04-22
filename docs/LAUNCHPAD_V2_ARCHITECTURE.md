# Launchpad V2 Architecture

Developer-facing reference for the v2 NFT launchpad: contract layout, frontend wiring, upload flow, and the pending address migration.

## Contents

- [V1 vs V2 diff](#v1-vs-v2-diff)
- [Contract layer](#contract-layer)
- [Frontend layer](#frontend-layer)
- [Upload flow (Irys / Arweave)](#upload-flow-irys--arweave)
- [Draft persistence](#draft-persistence)
- [Address migration](#address-migration)

---

## V1 vs V2 diff

V1 (`TegridyLaunchpad` + `TegridyDrop`) was shipped in an earlier wave and is frozen for existing collections. V1 source was deleted 2026-04-19; V1 clones on mainnet remain live and readable through the V2 Drop ABI (strict superset at the read surface). V2 replaces V1 with:

| Change                                | Why                                                                                                                                   |
|---------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|
| Single `InitParams` struct            | V1 called `initialize(...)`, then `setBaseURI`, then `setMerkleRoot`, then `configureDutchAuction` — four txs, window for half-init.  |
| `contractURI()` (ERC-7572)            | V1 had no collection-level metadata. OpenSea banner/description had to be configured manually in the OpenSea dashboard.               |
| `initialPhase` on deploy              | V1 deployed `CLOSED` and required a separate `setMintPhase` tx before anyone could mint.                                              |
| Empty-string-ok for `placeholderURI`  | V1 required a placeholder URI up-front. V2 allows pure-reveal flows.                                                                  |
| `MaxSupplyTooLarge` + `MintPriceTooHigh` guards | Defense in depth against typo'd deploys (e.g. `10**18` max supply).                                                                   |
| Rich `CollectionCreatedV2` event      | Indexers can read `contractURI`, `merkleRoot`, and `initialPhase` without a follow-up read.                                           |

Backward compatibility: V2 still emits the V1-shaped `CollectionCreated` event (same topic signature) so existing indexers work unchanged.

## Contract layer

### `TegridyDropV2` — the collection template

Implements ERC-721 + ERC-2981 (royalty) + ERC-7572 (`contractURI`) + Pausable + ReentrancyGuard. Deployed once by the factory constructor and cloned via EIP-1167 for every drop.

Key storage slots:

```solidity
string private _baseTokenURI;   // pre-reveal placeholder OR post-reveal base
string private _revealURI;      // set on reveal()
bool   public revealed;
string private _contractURI;    // ERC-7572 collection metadata JSON URI
address public creator;         // owner, royalty recipient
```

The initializer takes a single `InitParams` struct:

```solidity
struct InitParams {
    string name; string symbol;
    uint256 maxSupply; uint256 mintPrice; uint256 maxPerWallet;
    uint16 royaltyBps;
    address creator; address platformFeeRecipient; uint16 platformFeeBps;
    address weth;
    string placeholderURI; string contractURI_;
    bytes32 merkleRoot;
    uint256 dutchStartPrice; uint256 dutchEndPrice;
    uint256 dutchStartTime;  uint256 dutchDuration;
    MintPhase initialPhase;
}
```

Optional-field semantics: empty `placeholderURI` / `contractURI_`, `bytes32(0)` `merkleRoot`, and all-zero dutch fields skip the corresponding config. `initialPhase = CLOSED` means minting stays off until the owner calls `setMintPhase`.

Mint flow:

- `mint(quantity, proof)` — checked against `mintPhase` (`CLOSED | ALLOWLIST | PUBLIC | DUTCH_AUCTION | CANCELLED`). `ALLOWLIST` verifies `proof` against `merkleRoot` with the double-hashed leaf `keccak256(bytes.concat(keccak256(abi.encode(address(this), msg.sender))))` (AUDIT NEW-L5 — OpenZeppelin v4.9+ second-preimage-safe shape). `DUTCH_AUCTION` price decays linearly per-block.
- Overpayment is refunded via `WETHFallbackLib.safeTransferETHOrWrap` — if the minter is a contract that reverts on `.call`, the refund is wrapped to WETH and pushed instead of lost.

Cancel / refund:

- `cancelSale()` (owner) → `MintPhase.CANCELLED`. One-way.
- Every minter can then call `refund()` to pull back exactly `paidPerWallet[msg.sender]`. No partial refunds; the balance stays locked until every minter claims.

### `TegridyLaunchpadV2` — the factory

A thin `Clones.cloneDeterministic` wrapper. Its `CollectionConfig` struct is a superset of `InitParams` minus the per-deploy addresses (`creator`, `platformFee*`, `weth`) which it fills in automatically:

```solidity
struct CollectionConfig {
    string name; string symbol;
    uint256 maxSupply; uint256 mintPrice; uint256 maxPerWallet;
    uint16 royaltyBps;
    string placeholderURI; string contractURI;
    bytes32 merkleRoot;
    uint256 dutchStartPrice; uint256 dutchEndPrice;
    uint256 dutchStartTime;  uint256 dutchDuration;
    TegridyDropV2.MintPhase initialPhase;
}
```

Admin surface:

- `proposeProtocolFee / executeProtocolFee / cancelProtocolFee` — 48-hour timelocked.
- `proposeProtocolFeeRecipient / ...` — same mechanism.
- `pause / unpause` — blocks new `createCollection` calls.

`MAX_PROTOCOL_FEE_BPS = 1000` (10%) hard-caps the factory side; individual drops also cap at 10,000 (100%) internally.

## Frontend layer

### State machine: `wizardReducer.ts`

Finite state with 5 steps. All state lives in a single `WizardState`; every mutation goes through the reducer. No component-local mutation outside `useRef`-held form refs.

```
┌────────────┐   STEP_NEXT   ┌────────────┐   STEP_NEXT   ┌────────────┐
│ 1: Connect │ ─────────────▶│ 2: Upload  │ ─────────────▶│ 3: Preview │
└────────────┘               └────────────┘               └────────────┘
                                   ▲                             │
                                   │ STEP_BACK                   │ STEP_NEXT
                                   │                             ▼
┌────────────┐   STEP_NEXT   ┌────────────┐   STEP_NEXT   ┌────────────┐
│ 5: Deploy  │ ◀─────────────│ 4: Fund/Up │ ◀─────────────│            │
└────────────┘               └────────────┘               │            │
```

Actions are tagged unions. Highlights:

- `SET_FIELD` — generic typed-field update; `{ field: keyof WizardState, value: unknown }`.
- `HYDRATE` — merges a partial draft payload. Preserves `File` instances already in state because drafts can't serialize them.
- `QUOTE_RECEIVED` — stores the Irys quote as a `bigint` (wei). Reducer preserves type.
- `DEPLOY_SUCCESS` — writes both `txHash` and `collection` so the UI can link to both Etherscan and the new contract.
- `RESET` — returns to `initialState` by reference (not a clone). Used by "Deploy another collection" button.

Selectors (pure functions taking `WizardState`):

- `canAdvanceFromStep2(s)` — name, symbol, at least one image, CSV text, zero validation errors.
- `canAdvanceFromStep3(s)` — parsed rows non-empty, zero validation errors.
- `canAdvanceFromStep4(s)` — both `imagesManifestId` and `metadataManifestId` set.

Tests: [`wizardReducer.test.ts`](../frontend/src/components/launchpad/wizard/wizardReducer.test.ts) covers every action + all three selectors.

### Components

Five step components + a stepper, all under `frontend/src/components/launchpad/wizard/`:

| File                  | Role                                                                        |
|-----------------------|-----------------------------------------------------------------------------|
| `CreateWizard.tsx`    | Top-level container. Owns the reducer + persist hook.                       |
| `WizardStepper.tsx`   | Progress indicator; presentational.                                         |
| `Step1_Connect.tsx`   | Wallet connect + chain check.                                               |
| `Step2_Upload.tsx`    | Metadata form + file pickers + inline CSV/image validation.                 |
| `Step3_Preview.tsx`   | Parses CSV, renders first N tokens via `MetadataGrid.tsx`.                  |
| `Step4_FundUpload.tsx`| Drives `useIrysUpload` through quote → fund → upload sequence.              |
| `Step5_Deploy.tsx`    | Reads V2 factory ABI, calls `createCollection`, parses `CollectionCreated`. |

All components dispatch into the reducer; they never mutate state themselves.

## Upload flow (Irys / Arweave)

Driven by `useIrysUpload` (`frontend/src/hooks/useIrysUpload.ts`). Sequence:

1. **Quote** — `quote(totalBytes)` calls the Irys node's `/price/ethereum/:bytes` endpoint, returns wei as `bigint`. Dispatched as `QUOTE_RECEIVED`.
2. **Fund** — `fund(amountWei)` sends ETH to the Irys bundler. Returns the tx hash. Dispatched as `FUND_SUCCESS`.
3. **Upload images** — `uploadFolder(files)` posts a manifest containing every image. Resolves to `ar://<manifestId>/<filename>`. Dispatched as `IMAGES_UPLOADED`.
4. **Build metadata** — for each CSV row, `buildTokenMetadata(row, "ar://<manifestId>/<file_name>")`. Files are `<tokenId>.json`.
5. **Upload metadata** — another `uploadFolder(...)` call with the JSON files. Dispatched as `METADATA_UPLOADED`.
6. **Upload cover / banner** — single `uploadJson`-style calls if provided. Optional.
7. **Upload contractURI JSON** — built via `buildContractMetadata(...)`, uploaded as a single tx. Dispatched as `CONTRACT_URI_UPLOADED`.

All uploads are addressable at `ar://<txid>` (collection-level JSON) or `ar://<manifestId>/<filename>` (folder-style). The deployed contract is given:

- `placeholderURI` = `ar://<metadataManifestId>/1.json` (or a pre-reveal placeholder).
- `contractURI_` = `ar://<contractUriId>`.

Reveal is a later step — owner calls `reveal(revealUri)` with the permanent `ar://<metadataManifestId>/` base when ready.

## Draft persistence

Implemented by [`useWizardPersist`](../frontend/src/hooks/useWizardPersist.ts). Writes a debounced snapshot of `WizardState` to IndexedDB on every dispatch. On mount, it reads the latest snapshot and dispatches `HYDRATE` with it.

What's persisted:

- All scalar fields (strings, numbers, bigint-as-string, nullable records).
- `rows`, `validationWarnings`, `validationErrors`.
- Upload receipts (`fundTxId`, `imagesManifestId`, etc.) — so a refresh mid-upload resumes correctly.
- `deployTxHash` and `deployedAddress` — for the Step 5 "you already deployed this" screen.

What's **not** persisted:

- `File` objects (`imageFiles`, `coverFile`, `bannerFile`). Browsers cannot serialize file handles without user re-consent. The wizard shows a "please re-select your files" banner on resume.
- The `error` record (transient; user-facing only).

## Address migration

The v2 factory is built and tested but not yet deployed to mainnet. The address constant is a placeholder:

```ts
// frontend/src/lib/constants.ts
export const TEGRIDY_LAUNCHPAD_V2_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
```

Every consumer guards on it:

```ts
const v2Live = TEGRIDY_LAUNCHPAD_V2_ADDRESS !== '0x0000000000000000000000000000000000000000';
```

Affected files (all render a "V2 launchpad not deployed yet" placeholder until the real address lands):

- `frontend/src/components/nftfinance/LaunchpadSection.tsx` — overview card.
- `frontend/src/components/launchpad/wizard/Step5_Deploy.tsx` — deploy step error.

### Deploy checklist

Once `DeployLaunchpadV2.s.sol` broadcasts the real factory:

1. Copy the address from `contracts/broadcast/DeployLaunchpadV2.s.sol/1/run-latest.json`.
2. Edit `frontend/src/lib/constants.ts` — replace the zero-address placeholder.
3. Update the "Deployed contracts" table in `README.md`.
4. Append a row to [`docs/MIGRATION_HISTORY.md`](MIGRATION_HISTORY.md) (old → new + reason).
5. Wire the indexer — Ponder config needs the new address + deploy block.
6. Run the full checklist in [`docs/DEPLOYMENT.md`](DEPLOYMENT.md): ownership to multisig, Etherscan verified, etc.

Until step 2 ships on `main`, the wizard surfaces a friendly error in Step 5 rather than silently routing to the zero address.
