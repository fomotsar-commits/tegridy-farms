/**
 * AUDIT R081 — Claim-rewards surfaces (zero coverage before).
 *
 * Tegridy distributes claimable yield from three surfaces:
 *   1. LP farming — `/farm` (LPFarmingSection)
 *   2. Restaking — `/farm` (RestakingPanel; "Claim N TOWELI" CTA)
 *   3. Bribes / gauge incentives — `/community` (gauge tab)
 *
 * ⚠ A CLAIM CTA IS POSITION-DEPENDENT. The original first test asserted a
 * /claim/i button is visible on /farm "when connected" — it is not, from a
 * cold account, and never was: the claim CTAs mount only once there is a
 * stake or accrued rewards to claim. That assertion could only ever have gone
 * green while the whole file was being skipped. What IS assertable without a
 * position is that each claim-bearing surface mounts, so that is what these
 * check; the claim TRANSACTION is the Anvil leg's job.
 */
import { test, expect, expectTxReceipt, advancePastApproval, advanceForkTime } from './fixtures/wallet';

const onAnvil = !!process.env.ANVIL_RPC_URL;

test.describe('Claim rewards surfaces', () => {
  test('/farm mounts the reward-bearing sections when connected', async ({ page, walletMock }) => {
    await walletMock.connect();
    await page.goto('/farm');
    // TWO SEPARATE FACTS, and collapsing them into one assertion is what made this
    // the flakiest test in the Anvil job.
    //
    // It used to be this line alone, on the default 5s budget. It could not
    // distinguish "the section is not there" from "the section is there and still
    // reading", because LPFarmingSection's loading skeleton rendered no heading at
    // all — two grey `animate-pulse` bars stood where its name goes. So a heading
    // that depends on nothing was gated behind an 11-call batch read, and on a COLD
    // Anvil fork that read is a coin flip against 5s. Measured on trunk across six
    // CI runs: clean passes at 2.5s / 3.8s / 3.9s, failures at 6.4s / 6.4s / 6.7s,
    // each of which then passed on retry #1 in 2.6-3.3s against a now-warm fork.
    // `retries: 2` therefore converted a real UI defect into `flaky`, which this
    // job reports as a WARNING and not a failure (ci.yml only fails on skips), so
    // it sat on trunk half-green for as long as the spec existed.
    //
    // The skeleton now carries the section's real heading — it is a compile-time
    // constant and never needed a read — so:
    //
    //   1. the heading proves the section MOUNTED, and resolves on first paint;
    //   2. a read-derived stat proves the batch LANDED, on its own named budget.
    //
    // Do not merge these back together. Asserting only (1) would pass over a
    // section wedged in its skeleton forever, which is precisely the user-facing
    // failure this surface must not have; asserting only (2) would stop covering
    // the mount. LPFarmingSection.loading.test.tsx pins the split from the other
    // side — it fails if the skeleton ever starts rendering the stats.
    await expect(
      page.getByRole('heading', { name: /lp farming/i }),
      'the LP farming section did not mount on /farm at all — its heading is a static ' +
        'string that needs no chain read, so this is a render failure, not RPC latency.',
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: /stake toweli/i })).toBeVisible();

    // 30s, matching this file's other chain-dependent budgets.
    //
    // BE PRECISE ABOUT WHAT WAS MEASURED: the 6.4-6.7s figures above are whole-TEST
    // durations, of which 5s was the old assertion waiting and giving up. So the
    // cold read is known to exceed 5s and its true ceiling was never observed —
    // the old budget abandoned before it landed. 30s is therefore headroom over an
    // unmeasured bound, not a tight fit to a known one, which is the right shape
    // here: the job runs on a fork whose first read of every storage slot is a
    // round trip to a public upstream, and the failure this guards is a section
    // that NEVER resolves, not one that resolves slowly. If this starts timing
    // out, read useLPFarming's batch (gated `isDeployed && onMainnet`, and note
    // that a disabled query would render the panel, not this skeleton — TanStack's
    // isLoading is `isPending && isFetching`) before touching the number.
    await expect(
      page.getByText(/total lp staked/i),
      'the LP farming section mounted but never left its loading skeleton — the ' +
        'useLPFarming batch read never resolved. For a user on a slow RPC that is a ' +
        'reward-bearing surface stuck as a shimmer. Check the multicall, not this timeout.',
    ).toBeVisible({ timeout: 30_000 });
    // No position ⇒ no claim CTA.
    //
    // ⚠ THIS ASSERTION USED TO BE VACUOUS. It read `/^claim\s+\d/i` — "claim", space,
    // DIGIT — and no claim CTA on /farm is named that way in any state. StakingCard
    // renders "Claim Rewards" (StakingCard.tsx:228) and LPFarmingSection renders
    // "Claim Rewards" (LPFarmingSection.tsx:210); the one "Claim <number> TOWELI" on
    // this page is the restaking panel's (FarmPage.tsx:518), and that whole block is
    // gated on `restaking.isDeployed` (FarmPage.tsx:452) against
    // TEGRIDY_RESTAKING_ADDRESS, which is the zero address. So the old count-0 held for
    // a cold account, a rich account, and a broken build alike — it could not fail.
    // Matching the copy the app actually ships is what makes it a gate.
    await expect(page.getByRole('button', { name: /^claim/i })).toHaveCount(0);
  });

  test('/community renders the gauge / governance surfaces under mock wallet', async ({ page, walletMock }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await walletMock.connect();
    await page.goto('/community');
    await expect(page.locator('h1')).toContainText(/community/i);
    for (const label of [/governance/i, /bounties/i, /vote incentives/i, /gauge voting/i]) {
      await expect(page.getByRole('tab', { name: label })).toBeVisible();
    }
    expect(pageErrors).toEqual([]);
  });

  test('gauge voting tab (bribe claims live here) opens without crash', async ({ page, walletMock }) => {
    await walletMock.connect();
    await page.goto('/community');
    const gauge = page.getByRole('tab', { name: /gauge voting/i });
    await gauge.click();
    await expect(gauge).toHaveAttribute('aria-selected', 'true');
  });

  /**
   * ⚠ WHY THIS LEG MOVED OFF THE LP FARMING SURFACE — measured, on a live fork.
   *
   * It used to be "claim from LP farming surface" and it could not run, for two reasons
   * that no fixture can seed away:
   *
   *   1. THE LOCATOR MATCHED NOTHING. It waited on `/^claim\s+\d/i`. The LP farming
   *      claim CTA is named "Claim Rewards" (LPFarmingSection.tsx:210) — no digit — so
   *      the wait could only ever time out, accrued rewards or not. Both prior
   *      diagnoses proposed "pre-fund reward storage"; that would not have turned this
   *      green, because the button it was waiting for is not the button the app draws.
   *   2. LP FARMING CANNOT ACCRUE ON A FORK OF MAINNET AT HEAD. Read from the chain:
   *      LP_FARMING.periodFinish() == 1781493095 (2026-06-15) and it is unfunded.
   *      Synthetix accrual clamps at `min(now, periodFinish)`, so a staker joining now
   *      earns exactly zero forever. Restarting it needs `notifyRewardAmount`, which is
   *      owner-only — forging a reward epoch the protocol is not in would make this
   *      test assert a fiction.
   *
   * So this now drives the claim path that IS live: TOWELI staking. Read from the
   * chain, TegridyStaking has rewardRate() == 0.8243 TOWELI/s and holds 4.51M TOWELI
   * against 600k staked, so rewards accrue for real and the contract can pay them. The
   * accrual below comes from the contract's own math after the fork clock moves — not
   * from storage we wrote.
   *
   * [op] TWO CLAIM SURFACES REMAIN UNCOVERABLE UNTIL AN OPERATOR ACTS, and neither is
   * a test defect:
   *   • Restaking claims — TEGRIDY_RESTAKING_ADDRESS is 0x000…0 ("DEFERRED to Phase 7",
   *     constants.ts:23). The panel is gated off at FarmPage.tsx:452. Deploy it and set
   *     the constant, then a "Claim <n> TOWELI" leg becomes writable.
   *   • LP farming claims — refund the farm (notifyRewardAmount from the owner Safe) so
   *     periodFinish moves ahead of now. Until then there is nothing to claim there.
   */
  test('claim accrued TOWELI staking rewards (Anvil only)', async ({ page, walletMock }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');
    // Three on-chain transactions on a live fork — approve, stake, claim — with a
    // clock advance and a reload between the stake and the claim. Each assertion below
    // keeps its own tight, named budget.
    test.setTimeout(180_000);

    // ISOLATED WALLET — see the note in stake.spec.ts. This leg opens a position too,
    // and it also jumps the fork clock, so it must not be spending from the wallet the
    // render specs read.
    const account = await walletMock.useIsolatedForkAccount();
    await walletMock.connect(account);
    await page.goto('/farm');

    // 1. Open a position, so there is something for rewards to accrue against.
    // 40,000 TOWELI, not a token amount, and the size is doing real work. Rewards accrue
    // pro-rata against ~1.73M boosted stake already on the contract, so a 100-TOWELI
    // position needs minutes of fork time to clear the 0.01 TOWELI floor the claim CTA
    // gates on — and fork time is the one thing that must stay cheap here (see
    // advanceForkTime). A large position buys the same rewards in seconds. 40,000 sits
    // under the contract's own maxStakePerUser of 50,000, read from chain.
    const amount = page.getByRole('textbox', { name: /amount of toweli to stake/i });
    await amount.fill('40000');
    const stakeCard = amount.locator('xpath=ancestor::div[contains(@class,"glass-card")][1]');
    const stakeCta = stakeCard.getByRole('button', { name: /^(approve|stake)/i }).last();
    await advancePastApproval(stakeCta, /^Stake & Lock for /, 'stake (claim precondition)');
    await stakeCta.click();
    const stakeHash = await expectTxReceipt(page, 'stake (claim precondition)');
    await expect(
      page.getByRole('heading', { name: /^Your Position$/i }),
      'the precondition stake confirmed but no position surfaced — there is nothing for rewards to accrue against.',
    ).toBeVisible({ timeout: 30_000 });

    // 2. Let the contract accrue — 120 seconds of fork time, NOT more.
    //
    // The arithmetic, from values read off the chain: rewardRate() is 0.8243 TOWELI/s
    // shared across ~1.73M boosted stake, so a 40,000 position takes roughly a 2.2%
    // share and earns ~2.2 TOWELI in two minutes — some 200x the 0.01 floor the claim
    // CTA gates on (StakingCard.tsx:226). This deliberately buys the margin with stake
    // size rather than with clock: the skew this leaves on the shared fork is permanent,
    // and past ~1800s it starts reverting other specs' router calls as EXPIRED. An
    // earlier draft jumped seven days and did exactly that.
    await advanceForkTime(120);
    await page.reload();

    // 3. Claim. Scoped to the position card so LP farming's identically-named CTA on
    // this same page cannot stand in for it.
    const positionCard = page
      .getByRole('heading', { name: /^Your Position$/i })
      .locator('xpath=ancestor::div[contains(@class,"glass-card")][1]');
    const claim = positionCard.getByRole('button', { name: /^Claim Rewards$/i });
    await expect(
      claim,
      'the claim CTA never enabled after a week of fork time on a real position — either accrual stopped ' +
        'on TegridyStaking or the reward pool is exhausted. Check rewardRate() and the contract TOWELI balance ' +
        'before touching this assertion.',
    ).toBeEnabled({ timeout: 30_000 });
    await claim.click();
    // `stakeHash` bars the stake's own receipt from satisfying the claim.
    await expectTxReceipt(page, 'claim', stakeHash);
  });
});
