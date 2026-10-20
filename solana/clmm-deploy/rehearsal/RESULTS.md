# The deploy pack, rehearsed

**What it means.** The whole mainnet folder (`solana/clmm-deploy`, staged by `stage.mjs --kind
rehearsal`) ran end to end on a local chain: the owner's own Solana tool (4.1.1) did the uploads,
the deploy and the hand-over to the vault; the proposal was made, approved and executed against the
real Squads program and a copy of the vault's multisig (members swapped for local keys, a
20-second lock standing in for 48 hours, a 240-second notice for 7 days);
a stand-in served GitHub's merge history and the website's position link; the execute went through
the real page in headless Chromium, signed by a stand-in wallet with the local member key. Each
refusal the folder promises was tried. 63 steps, none failed.

The paying wallet was funded with exactly what the check before anything is spent asks (10.633650 SOL at that chain's rent, which is higher than mainnet's), plus the pool pack's share, and that was enough. The upload took 10.610441 SOL from it: 10.602453 SOL parked in the buffer and 0.007988 SOL in fees. The deploy then moved the buffer's SOL into the program's data and charged the wallet only the rest: it held 1.023209 SOL before the deploy and 1.021997 SOL after, the pool pack's share untouched. It never needed two buffers' worth. Member A's proposal cost it 0.006512 SOL.

The program file was this source run through `program-id-change.mjs` for a throwaway address
(`86rg5urhiPz5xaTmP6a6pSsyiAGhofRVxwrdLwtVC26L`, a local key, never used on mainnet or devnet), built with no features:
1,523,176 bytes, sha256 `cd8f76476ed230550a78d9ae6952c54df5b2fbf8795e21744cd01c89a6c02be4`.

Run 2026-10-20T22:10:49.144Z. Nothing was deployed anywhere but the local chain, and nothing was signed or sent on
mainnet or devnet: they were only read.

| | What was tried | | What happened |
|---|---|---|---|
| R0 | stage.mjs makes a rehearsal folder | pass | staged a rehearsal folder at C:\Users\jimbo\dev\clmm-localnet-work\rehearsal\pack |   program 86rg5urhiPz5xaTmP6a6pSsyiAGhofRVxwrdLwtVC26L, binary sha256 cd8f76476ed230550a78d9ae6952c54df5b2fbf8795e21744cd01c89a6c02be4 ( |
| R1 | stage.mjs refuses to replace a folder it did not make (it never deletes one) | pass | STOPPED: C:\Users\jimbo\dev\clmm-localnet-work\rehearsal exists and was not made by this script: it is never replaced. Choose another --out |
| K1 | 0-program-key: the rehearsal key and its data address are fresh on mainnet and devnet | pass | this key may become the range program's address. |
| K2 | 0-program-key refuses a key the build tool wrote (target\deploy) | pass | REFUSED (1 line). Do not use this key. Make a new one with the command in START-HERE.md. |
| B0 | a buffer holding another build (the placeholder one) is uploaded, for the refusals | pass | Buffer: 4c1uHFxQNkcUCExZQSDX7KLBBZ1msLkrksMiH76eehCx |
| B1 | 2-verify-buffer refuses a buffer that is not the reviewed build | pass | REFUSED (1 line). Do not deploy from this buffer. Do what the REFUSED line says. |
| B2 | 3-deploy --send refuses that buffer and sends nothing | pass | REFUSED (1 line). Nothing was sent. Do what the REFUSED line says. |
| C1 | 7-close-buffer refuses a buffer of another build, and sends nothing | pass | REFUSED (1 line). Nothing was sent. |
| S1 | the attack is real: with SOL at its data address, the loader refuses to deploy that address | pass |   Program BPFLoaderUpgradeab1e11111111111111111111111 failed: custom program error: 0x0 |
| S2 | the folder's check refuses such an address before anything is uploaded | pass |  |
| B3 | the paying wallet takes that buffer's SOL back alone (rehearsal clean-up) | pass | 4c1uHFxQNkcUCExZQSDX7KLBBZ1msLkrksMiH76eehCx | BBvaW9mvUDT1Waf9vXDwSU3TpLU2fBgjs8AzvRGFxayD | 10.60245336 SOL |
| S0a | an upload stopped half way: 2-verify-buffer says it is not finished, and nothing is lost | pass | REFUSED (1 line). Do not deploy from this buffer. Do what the REFUSED line says. |
| S0 | the very same upload command again carries on, and the buffer then holds the build | pass | Buffer: EdW7bfJrEfUpepSf3WVyUnsziV8vxfcxBNkHyi16NGsD; every line passed. This buffer may be deployed. |
| C2 | 7-close-buffer refuses this build's buffer when the paying wallet is not its authority | pass | REFUSED (1 line). Nothing was sent. |
| C3 | 7-close-buffer as a dry run passes on the paying wallet's own buffer of this build, and sends nothing | pass | the dry run passed. Run the same command with --send to take the SOL back. |
| C4 | 7-close-buffer --send closes it, and the SOL comes back to the paying wallet | pass | 10602448360 lamports back (the buffer held 10602453360) |
| P2 | every script stops on a folder with one bit changed in the program file (SHA256SUMS) | pass | STOPPED: this folder is not as it was staged: binary-to-deploy/raydium_clmm.cd8f7647.so (changed or missing). Ask a session. Nothing was read and nothing was sent. |
| P2b | every script stops on a folder with a second program file added (SHA256SUMS) | pass | STOPPED: this folder is not as it was staged: binary-to-deploy/other.so (not staged). Ask a session. Nothing was read and nothing was sent. |
| P0 | 1-preflight sets the pool pack's SOL aside while its Day 0 has not run, and asks for both | pass | REFUSED (1 line). Do what each REFUSED line says, then run this check again. |
| M1 | the paying wallet holds exactly the deploy's need plus the pool pack's share | pass | 11633650480 = buffer 10602453360 + program account 1141440 + data minus buffer 55680 + fees 30000000 + pool pack 1000000000 |
| P1 | 1-preflight passes | pass | every line passed. Go on to the next step in START-HERE.md. |
| U1 | the upload (solana write-buffer, the owner's command) finishes | pass | 10610441238 lamports left the wallet: 10602453360 parked in the buffer, 7987878 in fees |
| U2 | 2-verify-buffer passes on the real upload | pass | every line passed. This buffer may be deployed. |
| D0 | 3-deploy without --send is a dry run that passes and sends nothing | pass | the dry run passed. Run the same command with --send to deploy. |
| D1 | 3-deploy --send deploys at exact size and hands the program to the vault | pass | the program is deployed and the vault holds it. Go on to node "C:\Users\jimbo\dev\clmm-localnet-work\rehearsal\pack\scripts\4-verify-program.mjs". |
| M2 | the deploy never needed a second buffer's worth: the pool pack's share was never touched | pass | wallet 11633650480 -> after upload 1023209242 -> after deploy 1021997092; the pool pack's 1000000000 still there |
| D2 | 3-deploy refuses to deploy a second time | pass | REFUSED (1 line). Nothing was sent. |
| V1 | 4-verify-program: byte for byte, exact size, authority the vault; the vault's tier would work, a stranger's is refused | pass | the program is live, byte for byte the reviewed build, and only the vault can change it. |
| P3 | 1-preflight after the deploy refuses to start over | pass | REFUSED (1 line). Do what each REFUSED line says, then run this check again. |
| N0 | 5-record-notice refuses while the line is not on mvp-launch | pass | REFUSED (1 line). The notice is not public. |
| N1 | 5-record-notice records the notice: first seen by the network's clock, and the merge it came in | pass | the notice is public. The tiers may execute from 2026-10-20T22:11:37.000Z. Run this again within the hour before the approval and before the execute. |
| T0 | the page asks for a member wallet first | pass |  |
| T1 | the page offers nothing to a wallet outside the multisig | pass |  |
| T2 | two proposals are made outside the page (for the refusals) | pass | ok |
| T3 | the page refuses to go on while either touches the range program, even one that only names its data account | pass | proposal #15 (Active) touches the range program but is NOT this page's: never approve or execute it. A member rejects it in the Squads app; then check again | proposal #16 (Active) touches the range program but is NOT th |
| T4 | 1-preflight also names them and refuses | pass | REFUSED (2 lines). Do what each REFUSED line says, then run this check again. |
| T5 | member B rejects both (one rejection of a 2-of-2 ends each) | pass | 2nM1GwqmwmjUtCtF4J3D9BBoKc36dEvmVaRV73X5SUQmwcW4QDa21oDQNRkC9CtAcMAcDKhqT1danPHfkW9E5foS |
| T6 | with both rejected, the page offers member A to propose | pass | no tier proposal yet: #17 will be created, with your approval |
| T7 | member A creates and approves the tier proposal | pass | #17, member A spent 6511670 lamports; the transaction account 416 bytes (folder says 416), the proposal 262 (folder says 262) |
| T7b | the folder sizes the proposal accounts right (for the SOL member A needs) | pass |  |
| T8 | the stored proposal is byte for byte the page's | pass |  |
| T9 | member A, having approved, has nothing more to sign | pass |  |
| T10 | right after the proposal, the page tells member B to wait: the approval would let the lock end before the notice's days | pass | #17 waits for your approval from 2026-10-20T22:11:17Z by the network's clock, so that its 0.005555555555555556-hour lock ends no sooner than 0.002777777777777778 days after the notice (2026-10-20T22:11:37Z) |
| T10b | at that time it offers the approval (worked out with the network's clock moved there) | pass |  |
| T10c | it refuses while the website's position link answers for another program | pass | not live for this program ({"error":"No range position at this address.","program":"Gn672YyHXy3FeRPNViDfQPtcV9xs4UGPQQRJSJzs3MwT"}) |
| T10d | it refuses a notice record with a time that does not read as a time, or one checked over an hour ago | pass |  |
| T11 | an approval sent around the page lands (Squads cannot know of the notice) | pass | 4mN4TvaugvhrmhPVmcjLoE9d7eNLogkFNw2wd6bwcJVeHLWdYugJNGW2uGTfxGbqcNcEVb3WoHoZbDsZmgwcx2ez |
| T12 | the page then offers no execute: the time lock holds it, by the network's clock | pass | #17 has both approvals. The time lock holds it until 2026-10-20T22:08:00Z by the network's clock |
| T13 | an execute sent around the page now is refused by Squads itself (time lock) | pass |  |
| T14 | after the lock, the page still waits for the notice's days (the approval came early) | pass | the tiers may execute from 2026-10-20T22:11:37Z (0.002777777777777778 days after the notice), by the network's clock |
| T15 | with the line gone from mvp-launch, the record refuses and so does the page | pass | at the last check the notice line was NOT on mvp-launch: stop and ask |
| T15b | with it back, the notice starts again from the merge that brought it back | pass | first notice 2026-10-20T22:07:37.000Z, now 2026-10-20T22:08:07.000Z |
| T15c | SOL sent to a tier's address reads as "not made yet", and the page goes on | pass | the tiers may execute from 2026-10-20T22:12:07Z (0.002777777777777778 days after the notice), by the network's clock |
| T16 | with the lock over and the notice public for its days without a gap, the page offers the execute | pass | the fee notice has been public for 0.002777777777777778 days, without a gap |
| W0 | the page's server answers, and forbids being framed by another page | pass |  |
| W0b | the relay refuses a call from another web page | pass |  |
| W1 | the page loads on the local chain and says so | pass |  |
| W2 | connected as member A, the page offers the execute | pass |  |
| T17 | the page executes the proposal: both tiers are made (one address had been sent SOL first) | pass | 22:10:48  Done: proposal #17 is EXECUTED. Run 6-verify-tiers.mjs.22:10:46  sent 4Pxsi5iq982ZZT6PBUYEp3rQNzp3oGDmqSusvHpParNFb6mVccuF655AbMU328wsWsPjrw5Ap7f9XwKWzPyGD8Kd22:10:46  the network worked it ; the vault paid 170 |
| T19 | the page then says ALREADY DONE and offers nothing | pass |  |
| W3 | no error in the page's console | pass |  |
| T18 | 6-verify-tiers: both tiers exactly as decided, owner the vault, fund owner the Workshop | pass | both fee tiers are live with the island split. Anyone may now open a range pool on them. |
| V2 | 4-verify-program still passes after the tiers | pass | the program is live, byte for byte the reviewed build, and only the vault can change it. |

Run it again: `node solana/clmm-deploy/rehearsal/rehearse.mjs --binary <a build for a throwaway id>
--program-key <that id's key>` (see `../README.md`).
