# The deploy pack, rehearsed

**What it means.** The whole mainnet folder (`solana/clmm-deploy`, staged by `stage.mjs --kind
rehearsal`) ran end to end on a local chain: the owner's own Solana tool (4.1.1) did the uploads,
the deploy and the hand-over to the vault; the proposal was made, approved and executed against the
real Squads program and a copy of the vault's multisig (members swapped for local keys, a
20-second lock standing in for 48 hours, a 240-second notice for 7 days);
the proposal makes the one fee tier the owner ruled on 2026-10-25, 1%, and a copy of mainnet's #19
(the 1% and the 0.25% tier, approved by both members) was refused by the page, cancelled by both
members with Squads' own cancel, and then refused by Squads itself;
the proposal makes the one fee tier the owner ruled on 2026-10-25, 1%, and a copy of mainnet's #19
(the 1% and the 0.25% tier, approved by both members) was refused by the page, cancelled by both
members with Squads' own cancel, and then refused by Squads itself;
a stand-in served GitHub's merge history and the website's position link; the execute went through
the real page in headless Chromium, signed by a stand-in wallet with the local member key. Each
refusal the folder promises was tried. 67 steps, none failed.

The paying wallet was funded with exactly what the check before anything is spent asks (10.630588 SOL at that chain's rent, which is higher than mainnet's), plus the pool pack's share, and that was enough. The upload took 10.607379 SOL from it: 10.599391 SOL parked in the buffer and 0.007988 SOL in fees. The deploy then moved the buffer's SOL into the program's data and charged the wallet only the rest: it held 1.023209 SOL before the deploy and 1.021997 SOL after, the pool pack's share untouched. It never needed two buffers' worth. Member A's proposal cost it 0.005864 SOL.

The program file was this source, with the vault-power fixes of the owner's ruling (2026-10-20), run
through `program-id-change.mjs` for a throwaway address (`86rg5urhiPz5xaTmP6a6pSsyiAGhofRVxwrdLwtVC26L`, a local key, never used on
mainnet or devnet), built with no features: 1,522,736 bytes, sha256
`028ae72ddcd31a275c0c761ecc97802cae5adc6d9bf8bc415ec4dd17d91aa03e`.

Run 2026-10-25T07:40:48.173Z. Nothing was deployed anywhere but the local chain, and nothing was signed or sent on
mainnet or devnet: they were only read.

| | What was tried | | What happened |
|---|---|---|---|
| R0 | stage.mjs makes a rehearsal folder | pass | staged a rehearsal folder at C:\Users\jimbo\dev\clmm-localnet-work\rehearsal\pack \|   program 86rg5urhiPz5xaTmP6a6pSsyiAGhofRVxwrdLwtVC26L, binary sha256 028ae72ddcd31a275c0c761ecc97802cae5adc6d9bf8bc |
| R1 | stage.mjs refuses to replace a folder it did not make (it never deletes one) | pass | STOPPED: C:\Users\jimbo\dev\clmm-localnet-work\rehearsal exists and was not made by this script: it is never replaced. Choose another --out |
| K1 | 0-program-key: the rehearsal key and its data address are fresh on mainnet and devnet | pass | this key may become the range program's address. |
| K2 | 0-program-key refuses a key the build tool wrote (target\deploy) | pass | REFUSED (1 line). Do not use this key. Make a new one with the command in START-HERE.md. |
| B0 | a buffer holding another build (the placeholder one) is uploaded, for the refusals | pass | Buffer: 2nnQ5H1712hN5kHnfnHKsEWJQiZHZ4t8SGrChxCs96HR |
| B1 | 2-verify-buffer refuses a buffer that is not the reviewed build | pass | REFUSED (1 line). Do not deploy from this buffer. Do what the REFUSED line says. |
| B2 | 3-deploy --send refuses that buffer and sends nothing | pass | REFUSED (1 line). Nothing was sent. Do what the REFUSED line says. |
| C1 | 7-close-buffer refuses a buffer of another build, and sends nothing | pass | REFUSED (1 line). Nothing was sent. |
| S1 | the attack is real: with SOL at its data address, the loader refuses to deploy that address | pass |   Program BPFLoaderUpgradeab1e11111111111111111111111 failed: custom program error: 0x0 |
| S2 | the folder's check refuses such an address before anything is uploaded | pass |  |
| B3 | the paying wallet takes that buffer's SOL back alone (rehearsal clean-up) | pass | 2nnQ5H1712hN5kHnfnHKsEWJQiZHZ4t8SGrChxCs96HR \| BBvaW9mvUDT1Waf9vXDwSU3TpLU2fBgjs8AzvRGFxayD \| 10.59939096 SOL |
| S0a | an upload stopped half way: 2-verify-buffer says it is not finished, and nothing is lost | pass | REFUSED (1 line). Do not deploy from this buffer. Do what the REFUSED line says. |
| S0 | the very same upload command again carries on, and the buffer then holds the build | pass | Buffer: coew8N4pvBBy2cG1391fvgCiGNcBP3ecQ2bbeR4kkEj; every line passed. This buffer may be deployed. |
| C2 | 7-close-buffer refuses this build's buffer when the paying wallet is not its authority | pass | REFUSED (1 line). Nothing was sent. |
| C3 | 7-close-buffer as a dry run passes on the paying wallet's own buffer of this build, and sends nothing | pass | the dry run passed. Run the same command with --send to take the SOL back. |
| C4 | 7-close-buffer --send closes it, and the SOL comes back to the paying wallet | pass | 10599385960 lamports back (the buffer held 10599390960) |
| P2 | every script stops on a folder with one bit changed in the program file (SHA256SUMS) | pass | STOPPED: this folder is not as it was staged: binary-to-deploy/raydium_clmm.028ae72d.so (changed or missing). Ask a session. Nothing was read and nothing was sent. |
| P2b | every script stops on a folder with a second program file added (SHA256SUMS) | pass | STOPPED: this folder is not as it was staged: binary-to-deploy/other.so (not staged). Ask a session. Nothing was read and nothing was sent. |
| P0 | 1-preflight sets the pool pack's SOL aside while its Day 0 has not run, and asks for both | pass | REFUSED (1 line). Do what each REFUSED line says, then run this check again. |
| M1 | the paying wallet holds exactly the deploy's need plus the pool pack's share | pass | 11630588080 = buffer 10599390960 + program account 1141440 + data minus buffer 55680 + fees 30000000 + pool pack 1000000000 |
| P1 | 1-preflight passes | pass | every line passed. Go on to the next step in START-HERE.md. |
| U1 | the upload (solana write-buffer, the owner's command) finishes | pass | 10607378838 lamports left the wallet: 10599390960 parked in the buffer, 7987878 in fees |
| U2 | 2-verify-buffer passes on the real upload | pass | every line passed. This buffer may be deployed. |
| D0 | 3-deploy without --send is a dry run that passes and sends nothing | pass | the dry run passed. Run the same command with --send to deploy. |
| D1 | 3-deploy --send deploys at exact size and hands the program to the vault | pass | the program is deployed and the vault holds it. Go on to node "C:\Users\jimbo\dev\clmm-localnet-work\rehearsal\pack\scripts\4-verify-program.mjs". |
| M2 | the deploy never needed a second buffer's worth: the pool pack's share was never touched | pass | wallet 11630588080 -> after upload 1023209242 -> after deploy 1021997092; the pool pack's 1000000000 still there |
| D2 | 3-deploy refuses to deploy a second time | pass | REFUSED (1 line). Nothing was sent. |
| V1 | 4-verify-program: byte for byte, exact size, authority the vault; the vault's tier would work, a stranger's is refused | pass | the program is live, byte for byte the reviewed build, and only the vault can change it. |
| P3 | 1-preflight after the deploy refuses to start over | pass | REFUSED (1 line). Do what each REFUSED line says, then run this check again. |
| N0 | 5-record-notice refuses while the line is not on mvp-launch | pass | REFUSED (1 line). The notice is not public. |
| N1 | 5-record-notice records the notice: first seen by the network's clock, and the merge it came in | pass | the notice is public. The tiers may execute from 2026-10-25T07:41:14.000Z. Run this again within the hour before the approval and before the execute. |
| T0 | the page asks for a member wallet first | pass |  |
| T1 | the page offers nothing to a wallet outside the multisig | pass |  |
| T2 | two proposals are made outside the page (for the refusals): the old two-tier one and one naming the data account | pass | ok |
| T2b | member B approves the two-tier one too: Approved by both, as mainnet's #19 is | pass | #21 Approved |
| T3 | the page refuses to go on while either touches the range program (both members cancel the approved two-tier one), even one that only names its data account | pass | proposal #21 (Approved) touches the range program but is NOT this page's: never approve or execute it. Both members cancel it in the Squads app; then check again \| proposal #22 (Active) touches the ra |
| T4 | 1-preflight also names them and refuses | pass | REFUSED (2 lines). Do what each REFUSED line says, then run this check again. |
| T5 | member B rejects the one naming the data account (one rejection of a 2-of-2 ends it) | pass | 4491tY9a2bM8VfRQ46kgNuntMMM6briv2YpBcJuvwrCRiRgzfKmLkfKmiVnj2ZBo234xRNU5eexwDBQJnuRGjnWb |
| T5b | member A cancels the two-tier one: one cancel of a 2-of-2 is not enough, it stays Approved and the page still refuses | pass | #21 Approved, 1 cancel |
| T5c | member B cancels it too: Cancelled, and an execute of it is refused for its status (InvalidProposalStatus), not for the lock | pass | #21 Cancelled; execute: Program log: AnchorError thrown in programs/squads_multisig_program/src/instructions/vault_transaction_execute.rs:75. Error Code: InvalidProposalStatus. Error Number: 6008. Err |
| T6 | with both ended, the page offers member A to propose | pass | no tier proposal yet: #23 will be created, with your approval |
| T7 | member A creates and approves the tier proposal | pass | #23, member A spent 5864390 lamports; the transaction account 323 bytes (folder says 323), the proposal 262 (folder says 262) |
| T7b | the folder sizes the proposal accounts right (for the SOL member A needs) | pass |  |
| T8 | the stored proposal is byte for byte the page's | pass |  |
| T9 | member A, having approved, has nothing more to sign | pass |  |
| T10 | right after the proposal, the page tells member B to wait: the approval would let the lock end before the notice's days | pass | #23 waits for your approval from 2026-10-25T07:40:54Z by the network's clock, so that its 0.005555555555555556-hour lock ends no sooner than 0.002777777777777778 days after the notice (2026-10-25T07:4 |
| T10b | at that time it offers the approval (worked out with the network's clock moved there) | pass |  |
| T10c | it refuses while the website's position link answers for another program | pass | not live for this program ({"error":"No range position at this address.","program":"FzuNvHiVWrMMQqEH2E1rDjSTTbAtBt77CTcj6HXEsW7v"}) |
| T10d | it refuses a notice record with a time that does not read as a time, or one checked over an hour ago | pass |  |
| T11 | an approval sent around the page lands (Squads cannot know of the notice) | pass | 2da9JXQqUZAjigfg2Lf16WFu56GBhahYCPrpX4io6n14xSazJiQ1PoqcitPY69yXnnY5mQEhP9Nhds5jzGsHfXZe |
| T12 | the page then offers no execute: the time lock holds it, by the network's clock | pass | #23 has both approvals. The time lock holds it until 2026-10-25T07:37:38Z by the network's clock |
| T13 | an execute sent around the page now is refused by Squads itself (time lock) | pass |  |
| T14 | after the lock, the page still waits for the notice's days (the approval came early) | pass | the tiers may execute from 2026-10-25T07:41:14Z (0.002777777777777778 days after the notice), by the network's clock |
| T15 | with the line gone from mvp-launch, the record refuses and so does the page | pass | at the last check the notice line was NOT on mvp-launch: stop and ask |
| T15b | with it back, the notice starts again from the merge that brought it back | pass | first notice 2026-10-25T07:37:14.000Z, now 2026-10-25T07:37:44.000Z |
| T15c | SOL sent to a tier's address reads as "not made yet", and the page goes on | pass | the tiers may execute from 2026-10-25T07:41:44Z (0.002777777777777778 days after the notice), by the network's clock |
| T16 | with the lock over and the notice public for its days without a gap, the page offers the execute | pass | the fee notice has been public for 0.002777777777777778 days, without a gap |
| W0 | the page's server answers, and forbids being framed by another page | pass |  |
| W0b | the relay refuses a call from another web page | pass |  |
| W1 | the page loads on the local chain and says so | pass |  |
| W2 | connected as member A, the page offers the execute | pass |  |
| T17 | the page executes the proposal: the fee tier is made (its address had been sent SOL first) | pass | 07:40:22  Done: proposal #23 is EXECUTED. Run 6-verify-tiers.mjs.07:40:20  sent SErivGj7snQLmGzA9KM3zxFTPBhCvX4WUEiQiNxy8HMGDSx5Hby879NwDcLdXkUVyaNK837zMmTEkD3LQqwmFxW07:40:20  the network worked it o |
| T19 | the page then says ALREADY DONE and offers nothing | pass |  |
| W3 | no error in the page's console | pass |  |
| T18 | 6-verify-tiers: the fee tier exactly as decided, owner the vault, fund owner the Workshop, and no other tier | pass | the fee tier is live with the island split, and it is the only one. Anyone may now open a range pool on it. |
| V2 | 4-verify-program still passes after the tier | pass | the program is live, byte for byte the reviewed build, and only the vault can change it. |
| T20 | 6-verify-tiers refuses once a tier this pack does not make exists (the 0.25% one, made by a proposal of its own) | pass |   REFUSED : a fee tier this pack does not make exists: index 1, 0.25% of each swap (5DjsHWfk3dpBEmqsGn6dr7H5aKiJxdpkkCsVgE4RntgE). It cannot be removed. Stop and ask |

Run it again: `node solana/clmm-deploy/rehearsal/rehearse.mjs --binary <a build for a throwaway id>
--program-key <that id's key>` (see `../README.md`).
