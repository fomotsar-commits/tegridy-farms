/**
 * Claim-rewards surfaces. A claim CTA mounts only once there is a position or rewards to
 * claim, so the render test asserts each claim-bearing surface mounts; the claim
 * TRANSACTION is the Anvil leg's job.
 */
import { encodeFunctionData, formatEther, getAddress, hexToBigInt, parseAbi, type Address, type Hex } from 'viem';
import { test, expect, expectTxReceipt, expectMinedSuccessfully, anvilRpc, forkTxCount } from './fixtures/wallet';
import { STAKING_MONITOR_VIEW_ADDRESS, TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS } from '../src/lib/constants';

const onAnvil = !!process.env.ANVIL_RPC_URL;

const ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalStaked() view returns (uint256)',
  'function totalUnsettledRewards() view returns (uint256)',
  'function paused() view returns (bool)',
  'function ownerOf(uint256) view returns (address)',
  'function userTokenId(address) view returns (uint256)',
  'function earned(uint256) view returns (uint256)',
]);

/** StakingCard enables Claim from 0.01 TOWELI owed. */
const CLAIM_FLOOR_WEI = 10n ** 16n;
/** Solady's TokenDoesNotExist(): ownerOf for an id never minted, or burned at withdraw. */
const NO_SUCH_TOKEN = '0xceea21b6';

/** One word off the fork. An empty `0x` (no code there) throws: unread is not zero. */
async function readWord(to: string, data: Hex): Promise<Hex> {
  const result = (await anvilRpc('eth_call', [{ to, data }, 'latest'])) as Hex;
  if (result === '0x') throw new Error(`eth_call to ${to} returned no data — is the contract on this fork?`);
  return result;
}

async function readUint(to: string, data: Hex): Promise<bigint> {
  return hexToBigInt(await readWord(to, data));
}

const toweliBalance = (holder: Address) =>
  readUint(TOWELI_ADDRESS, encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [holder] }));

/** The reward pool exactly as StakingRewardLib computes it; may be negative. */
async function stakingRewardReserve(): Promise<bigint> {
  const [balance, staked, iou] = await Promise.all([
    toweliBalance(TEGRIDY_STAKING_ADDRESS),
    readUint(TEGRIDY_STAKING_ADDRESS, encodeFunctionData({ abi: ABI, functionName: 'totalStaked' })),
    readUint(TEGRIDY_STAKING_ADDRESS, encodeFunctionData({ abi: ABI, functionName: 'totalUnsettledRewards' })),
  ]);
  return balance - staked - iou;
}

/** The holder of v1 position `id`, or null when there is none. Any other failed read throws. */
async function holderOf(id: bigint): Promise<Address | null> {
  try {
    const word = await readWord(TEGRIDY_STAKING_ADDRESS, encodeFunctionData({ abi: ABI, functionName: 'ownerOf', args: [id] }));
    return getAddress(`0x${word.slice(-40)}`);
  } catch (err) {
    if (String(err).includes(NO_SUCH_TOKEN)) return null;
    throw err;
  }
}

/**
 * The v1 position owed the most that the reserve pays in full, held by a plain wallet (no
 * code) that the site shows it to (userTokenId). Owed is `earned`, read where the site reads
 * it. Ids are scanned until 32 in a row have no position: mainnet minted 1 to 23.
 */
async function owedV1Staker(reserve: bigint): Promise<{ id: bigint; holder: Address; owed: bigint }> {
  const found: Array<{ id: bigint; holder: Address }> = [];
  let scanned = 0n;
  for (let empty = 0; empty < 32; scanned += 32n) {
    const ids = Array.from({ length: 32 }, (_, i) => scanned + 1n + BigInt(i));
    const holders = await Promise.all(ids.map(holderOf));
    for (const [i, holder] of holders.entries()) {
      if (holder) found.push({ id: ids[i]!, holder });
      empty = holder ? 0 : empty + 1;
    }
  }
  const read = await Promise.all(
    found.map(async ({ id, holder }) => {
      const [owed, shownId, code] = await Promise.all([
        readUint(STAKING_MONITOR_VIEW_ADDRESS, encodeFunctionData({ abi: ABI, functionName: 'earned', args: [id] })),
        readUint(TEGRIDY_STAKING_ADDRESS, encodeFunctionData({ abi: ABI, functionName: 'userTokenId', args: [holder] })),
        anvilRpc('eth_getCode', [holder, 'latest']) as Promise<Hex>,
      ]);
      return { id, holder, owed, eligible: code === '0x' && shownId === id && owed >= CLAIM_FLOOR_WEI && owed <= reserve };
    }),
  );
  const pick = read.filter((p) => p.eligible).sort((a, b) => (b.owed > a.owed ? 1 : b.owed < a.owed ? -1 : 0))[0];
  if (!pick) {
    throw new Error(
      `No TOWELI staking v1 position on this fork can be claimed in full: ${found.length} position(s) on ids 1 to ` +
        `${scanned}, none owed between 0.01 TOWELI and the reserve (${formatEther(reserve)}) and held by a plain wallet ` +
        `the site shows it to. Owed: ${read.map((p) => `#${p.id} ${formatEther(p.owed)}`).join(', ') || 'none'}.`,
    );
  }
  return pick;
}

test.describe('Claim rewards surfaces', () => {
  test('/farm mounts the reward-bearing sections when connected', async ({ page, walletMock }) => {
    await walletMock.connect();
    await page.goto('/earn/toweli');
    // Two facts, two assertions. The heading is a static string, so it proves the section
    // MOUNTED on first paint; a read-derived stat proves its batch LANDED. Merged into one,
    // a slow cold-fork read failed as "not there" and passed on retry, which this job only
    // warns about. LPFarmingSection.loading.test.tsx pins the split from the render side.
    await expect(
      page.getByRole('heading', { name: /lp farming/i }),
      'the LP farming section did not mount on /farm at all — its heading is a static ' +
        'string that needs no chain read, so this is a render failure, not RPC latency.',
    ).toBeVisible();
    // TOWELI staking v1 is closing: with no position the card is its closed line.
    await expect(page.getByRole('heading', { name: /toweli staking v1/i })).toBeVisible();

    // 30 s: on a fork every first storage read is an upstream round trip, and the cold read
    // is known to exceed 5 s. What this guards is a batch that NEVER resolves. If it times
    // out, read useLPFarming's batch (gated `isDeployed && onMainnet`) before the number.
    await expect(
      page.getByText(/total lp staked/i),
      'the LP farming section mounted but never left its loading skeleton — the ' +
        'useLPFarming batch read never resolved. For a user on a slow RPC that is a ' +
        'reward-bearing surface stuck as a shimmer. Check the multicall, not this timeout.',
    ).toBeVisible({ timeout: 30_000 });
    // No position, no claim CTA. Both claim CTAs on this page are named "Claim Rewards"
    // (StakingCard, LPFarmingSection), so the pattern matches the copy the app ships.
    await expect(page.getByRole('button', { name: /^claim/i })).toHaveCount(0);
  });

  // TOWELI staking v1 is the claim path that is live (LP farming ended 2026-06-15, unfunded).
  // Its closing plan (docs/TODO_OPERATOR.md, "close TOWELI staking v1") sets the rate to 0 and
  // refills what is owed, so a new position earns nothing: the leg claims as a real staker
  // who is owed rewards, on the fork. It moves no clock and opens no position.
  test('claim accrued TOWELI staking rewards (Anvil only)', async ({ page, walletMock }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');
    test.setTimeout(120_000);

    // A failure by name, not a skip: ci.yml fails the job on any skip, with a generic reason.
    const paused = await readUint(TEGRIDY_STAKING_ADDRESS, encodeFunctionData({ abi: ABI, functionName: 'paused' }));
    if (paused !== 0n) {
      throw new Error(
        'TOWELI staking v1 is paused on this fork (the last step of "close TOWELI staking v1"): getReward ' +
          'reverts and the site disables Claim, so there is no claim left to drive. Retire this leg, and lower ' +
          "ci.yml's 20-test floor, together with stake.spec's openToweliStakeOnFork legs (stake() reverts too).",
      );
    }

    // A claim pays min(owed, reserve) and books the rest as an IOU, so on an empty reserve
    // it mines and pays nothing. Asked before anything is sent.
    const reserve = await stakingRewardReserve();
    if (reserve <= 0n) {
      throw new Error(
        `TegridyStaking's reward reserve on this fork is EMPTY (balance − totalStaked − IOUs = ` +
          `${formatEther(reserve)} TOWELI), so a claim pays nothing. This is chain state, not this PR: it stays ` +
          'red until the owner refills what is owed (notifyRewardAmount, "close TOWELI staking v1").',
      );
    }

    const staker = await owedV1Staker(reserve);
    // Gas money only. The bridge sends as `staker` by impersonation; no key exists.
    await anvilRpc('anvil_setBalance', [staker.holder, '0x8ac7230489e80000']); // 10 ETH
    await walletMock.connect(staker.holder);
    await page.goto('/earn/toweli');
    await expect(
      page.getByRole('heading', { name: /^Your Position$/i }),
      `staker ${staker.holder} holds v1 position #${staker.id} but the staking card does not show it.`,
    ).toBeVisible({ timeout: 30_000 });

    // Scoped to the position card: LP farming's CTA on this page has the same name.
    const positionCard = page
      .getByRole('heading', { name: /^Your Position$/i })
      .locator('xpath=ancestor::div[contains(@class,"glass-card")][1]');
    const claim = positionCard.getByRole('button', { name: /^Claim Rewards$/i });
    await expect(
      claim,
      `position #${staker.id} is owed ${formatEther(staker.owed)} TOWELI by earned(), but Claim never enabled.`,
    ).toBeEnabled({ timeout: 30_000 });

    const before = await toweliBalance(staker.holder);
    const since = forkTxCount(page);
    await claim.click();
    const hash = await expectMinedSuccessfully(page, 'claim', since);
    await expectTxReceipt(page, 'claim', { hash });
    const paid = (await toweliBalance(staker.holder)) - before;
    expect(
      paid,
      `the claim mined but paid ${formatEther(paid)} TOWELI against ${formatEther(staker.owed)} owed.`,
    ).toBeGreaterThanOrEqual(staker.owed);
  });
});
