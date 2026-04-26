# Agent 040 — ERC Standards Conformance Audit

Scope: `contracts/src/` — AUDIT-ONLY.

## Inventory

| Standard | Contract | File |
|---|---|---|
| ERC20 | Toweli (token + Permit/EIP-2612) | `Toweli.sol` |
| ERC20 | TegridyPair (LP token) | `TegridyPair.sol` |
| ERC721 | TegridyDropV2 (drop, Initializable clone) | `TegridyDropV2.sol` |
| ERC721 | TegridyStaking (tsTOWELI position NFT) | `TegridyStaking.sol` |
| IERC721Receiver | TegridyNFTPool | `TegridyNFTPool.sol` |
| IERC721Receiver | TegridyRestaking | `TegridyRestaking.sol` |
| IERC721Receiver | TegridyStaking | `TegridyStaking.sol` |
| ERC2981 | TegridyDropV2 | `TegridyDropV2.sol` |
| ERC4626 | (none — TegridyRestaking is a custom NFT-escrow restaker, NOT ERC4626) | — |
| ERC1155 | (none in scope) | — |

---

## ERC20 — Findings

### F-ERC20-01 (LOW): TegridyPair LP token has no `permit()`
- File: `TegridyPair.sol:24-25`
- Acknowledged in code (audit note #65). Not a conformance bug — ERC20Permit is optional. Documented gap; LP tokens require `approve+swap`-style flows.

### F-ERC20-02 (INFO): Toweli DOMAIN_SEPARATOR cross-chain replay safe
- File: `Toweli.sol` via OZ `EIP712.sol:74-91`
- OZ v5 EIP712 implementation rebuilds DOMAIN_SEPARATOR when `block.chainid != _cachedChainId` (line 83). Cross-chain replay on a forked deployment is NOT possible. CONFORMANT.

### F-ERC20-03 (INFO): Bare `transfer()` calls on TOWELI inside `try/catch`
- File: `CommunityGrants.sol:353,496,537`
- Calls TOWELI's bare `transfer(...)` (with bool return) from inside `try { ... } catch`. Toweli is OZ ERC20 (returns `true` on success / reverts on failure), so the bool branch + catch fallback is defensive but harmless. CONFORMANT.

### F-ERC20-04 (INFO): Direct WETH `transfer` (not SafeERC20)
- Files: `WETHFallbackLib.sol:51`, `CommunityGrants.sol:664`, `TegridyRouter.sol:280,325`
- Canonical WETH9 returns `bool` and is non-reverting — direct `transfer` w/ require is safe. NOT a USDT-style return-value bug because target is fixed canonical WETH at constructor. CONFORMANT.

### F-ERC20-05 (INFO): No burn-in-transfer / fee-on-transfer paths
- TegridyPair `swap()` explicitly rejects FoT/burn-in-transfer at every swap (`FOT_OUTPUT_0/1` checks at lines 243-244). `_rejectERC777` factory gate too. Not a totalSupply-drift surface.

### F-ERC20-06 (CONFORMANT): Decimals = 18 across the board
- Toweli: `1_000_000_000 ether` (18 dec, OZ default). TegridyPair: OZ default 18 dec. No surprises.

---

## ERC721 — Findings

### F-ERC721-01 (LOW): TegridyStaking uses `_mint` not `_safeMint`
- File: `TegridyStaking.sol:539,587`
- `stake()` mints the NFT via `_mint(msg.sender, ...)`. Standard ERC721 compliance only requires receiver-hook on `safeTransferFrom`; `_mint` itself is allowed. However, contract-wallet stakers that do not implement `IERC721Receiver` will silently receive the NFT (cannot send onward via `safeTransferFrom` — the inbound mint succeeds but later transfers may revert if recipient isn't a receiver). Standard practice is `_safeMint` to flag this earlier. **Non-blocking**, but a footgun. (The function is reachable by EOAs and contracts.)

### F-ERC721-02 (LOW): TegridyStaking has no `tokenURI` override
- File: `TegridyStaking.sol:1465` (comment: "tokenURI: uses base ERC721 (returns "" when no baseURI set)")
- OZ ERC721 default `tokenURI` reverts on burned/non-existent tokens via `_requireOwned`, then returns `""` (since `_baseURI` is not set). Marketplaces will display blank metadata; off-chain indexers must call `TegridyTokenURIReader.tokenURI(id)` instead. CONFORMANT but UX gap.

### F-ERC721-03 (LOW): TegridyTokenURIReader does NOT check token existence
- File: `TegridyTokenURIReader.sol:41-50`
- External reader returns SVG metadata for any tokenId, including burned tokens (positions struct returns zero values). Marketplaces calling this reader would render stale/zeroed metadata. Recommend adding `staking.ownerOf(tokenId)` (which reverts for burned) before generating SVG. **Non-blocking** because consumers integrating with this reader are aware.

### F-ERC721-04 (INFO): TegridyDropV2 `tokenURI` correctly handles burned tokens
- File: `TegridyDropV2.sol:239-247`
- `_requireOwned(tokenId)` reverts on burned/non-existent. CONFORMANT.

### F-ERC721-05 (INFO): TegridyDropV2 `supportsInterface` properly composes ERC721 + ERC2981
- File: `TegridyDropV2.sol:254-261`
- Override resolves both parent chains via `super.supportsInterface(interfaceId)`. CONFORMANT.

### F-ERC721-06 (INFO): TegridyStaking `supportsInterface` not explicitly overridden
- TegridyStaking inherits ERC721 only (not ERC2981, not ERC4906). Default OZ `supportsInterface` correctly reports IERC165 + IERC721 + IERC721Metadata. CONFORMANT.

### F-ERC721-07 (LOW): TegridyLending and TegridyNFTLending use `transferFrom` (not `safeTransferFrom`)
- Files: `TegridyLending.sol:462,534,584`, `TegridyNFTLending.sol:378,449,496`
- Both contracts escrow NFTs via raw `transferFrom`. They do NOT implement `IERC721Receiver`, so `safeTransferFrom`-style deposits would revert. This is intentional (escrow-only model — borrower must use the contract's accept function), and on the return path, recipients are EOAs (borrower/lender) for which the safe variant is functionally equivalent. **Non-blocking** but inconsistent with TegridyStaking + TegridyRestaking which use `safeTransferFrom`.
- Note: This means a malicious or misconfigured collateral collection where `_update`/`transferFrom` performs callbacks could enable XCC-reentrancy. TegridyStaking's own `_update` is pure-state (no callbacks), so the immediate path is safe — but TegridyNFTLending accepts arbitrary `collateralContract` (line 378), which could be any ERC721. Recommend `safeTransferFrom` + IERC721Receiver impl for a true defensive posture.

### F-ERC721-08 (INFO): TegridyRestaking `onERC721Received` gates origin to staking contract
- File: `TegridyRestaking.sol:1158-1161`
- Reverts unless `msg.sender == address(staking)`. Prevents random ERC721 deposits from polluting state. CONFORMANT.

### F-ERC721-09 (INFO): TegridyStaking `onERC721Received` gates JBAC
- File: `TegridyStaking.sol:600-602`
- Comment in `stakeWithJbac()` confirms gating to jbacNFT. CONFORMANT.

### F-ERC721-10 (INFO): TegridyDropV2 totalSupply mirrors mints, never decremented
- File: `TegridyDropV2.sol:90,303`
- `totalSupply` is a manual counter incremented on mint only. Drop has no public burn entrypoint (refund preserves NFT — only resets paid). Therefore `totalSupply` accurately reflects ever-minted, NOT current-circulating, but `maxSupply` is enforced against the same counter so cap-bypass via burn-then-remint is impossible. CONFORMANT.

---

## ERC2981 (Royalty) — Findings

### F-ERC2981-01 (INFO): TegridyDropV2 caps royalty at 10%
- File: `TegridyDropV2.sol:163,173`
- `MAX_ROYALTY_BPS = 1000` (10%). Tightened from 100% per AUDIT NEW-L7. CONFORMANT and prudent.

### F-ERC2981-02 (INFO): Default royalty only, no per-token override path
- File: `TegridyDropV2.sol:187`
- `_setDefaultRoyalty(creator, royaltyBps)` set once at init; no `setTokenRoyalty` exposed externally. `royaltyInfo(tokenId, salePrice)` returns the default for all tokens, including non-existent / burned (no existence check, per ERC2981 spec — does not require token existence). CONFORMANT.

### F-ERC2981-03 (INFO): Royalty receiver = creator (mutable via `transferOwnership` — but the receiver in the ERC2981 default is NOT updated on owner transfer)
- File: `TegridyDropV2.sol:187,467-475`
- After the creator transfers ownership, `royaltyInfo` continues to pay the original creator. This may be intentional (royalty stickiness) but is a UX surprise — there is no `setRoyaltyReceiver` admin path. **Non-blocking gap**. Re-deployment via factory is the only fix.

---

## ERC4626 — Findings

### F-ERC4626-01 (INFO): TegridyRestaking is NOT ERC4626
- The audit prompt referenced "ERC4626 (TegridyRestaking)" but the contract does not inherit ERC4626 / IERC4626. It is a **custom NFT-escrow restaking contract** with bespoke `restake/unrestake/claimAll` semantics. There is no `asset()`, `totalAssets()`, `previewDeposit/Mint/Withdraw/Redeem`, or share-token model. Spec mismatches in the prompt (preview vs actual, totalAssets pending withdrawals, donation-inflation) DO NOT APPLY.
- Donation-inflation guard is N/A: `bonusRewardPerSecond` is admin-set (timelocked) and `accBonusPerShare` accumulates via elapsed-time × rate / `totalRestaked`. There is no first-depositor inflation surface because no one mints "shares" — `boostedAmount` is read directly from TegridyStaking and is non-manipulable by a depositor.

---

## ERC1155 — Findings

### F-ERC1155-01 (N/A)
- No ERC1155 contracts in scope. `balanceOfBatch` / `safeTransferBatch` audit lines do not apply.

---

## Top-5 Conformance Gaps (sorted by impact)

1. **F-ERC721-07 (LOW)**: TegridyLending + TegridyNFTLending use raw `transferFrom` to escrow user NFTs — inconsistent with TegridyStaking/Restaking and skips IERC721Receiver hook on inbound. Defensive `safeTransferFrom` + receiver impl recommended.
2. **F-ERC721-01 (LOW)**: TegridyStaking `_mint` over `_safeMint` allows footgun for contract-wallet stakers without `IERC721Receiver`.
3. **F-ERC721-03 (LOW)**: TegridyTokenURIReader returns metadata for burned tokens (no `ownerOf` existence check).
4. **F-ERC2981-03 (LOW)**: TegridyDropV2 royalty receiver is sticky — does not follow `transferOwnership` to new owner.
5. **F-ERC721-02 (LOW)**: TegridyStaking has no `tokenURI` override; default returns blank string until baseURI set, breaking marketplace display.

No HIGH/CRITICAL ERC-conformance gaps detected. ERC20Permit DOMAIN_SEPARATOR is chain-id-safe via OZ v5 rebuild logic.
