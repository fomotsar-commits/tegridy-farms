/**
 * Claim-rewards surfaces. Without a position only each section's MOUNT is
 * assertable: the claim CTAs render only once there is a stake or rewards to
 * claim. The claim TRANSACTION is the Anvil leg's job.
 */
import {
  encodeFunctionData, formatEther, getAddress, hexToBigInt, isAddressEqual, parseAbi, parseEventLogs,
  type Address, type Hex, type Log,
} from 'viem';
import { test, expect, expectMinedSuccessfully, expectTxReceipt, forkTxCount, anvilRpc } from './fixtures/wallet';
import { STAKING_MONITOR_VIEW_ADDRESS, TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS } from '../src/lib/constants';
import { formatTokenAmount } from '../src/lib/formatting';

const onAnvil = !!process.env.ANVIL_RPC_URL;

const ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalStaked() view returns (uint256)',
  'function totalUnsettledRewards() view returns (uint256)',
  'function rewardRate() view returns (uint256)',
  'function paused() view returns (bool)',
  'function ownerOf(uint256) view returns (address)',
  'function userTokenId(address) view returns (uint256)',
  'function earned(uint256) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/** The claim CTA's own floor (StakingCard.tsx): below 0.01 TOWELI it stays disabled. */
const CLAIM_FLOOR_WEI = 10n ** 16n;

/** One uint256 off the fork. An empty `0x` (no code there) throws: unread is not zero. */
async function readUint(to: string, data: Hex): Promise<bigint> {
  const result = (await anvilRpc('eth_call', [{ to, data }, 'latest'])) as Hex;
  if (result === '0x') throw new Error(`eth_call to ${to} returned no data — is the contract on this fork?`);
  return hexToBigInt(result);
}

const toweliBalance = (who: Address) =>
  readUint(TOWELI_ADDRESS, encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [who] }));
const earnedOf = (tokenId: bigint) =>
  readUint(STAKING_MONITOR_VIEW_ADDRESS, encodeFunctionData({ abi: ABI, functionName: 'earned', args: [tokenId] }));

/** The reward pool exactly as StakingRewardLib computes it; may be negative. */
async function stakingRewardReserve(): Promise<bigint> {
  const [balance, staked, iou] = await Promise.all([
    toweliBalance(TEGRIDY_STAKING_ADDRESS),
    readUint(TEGRIDY_STAKING_ADDRESS, encodeFunctionData({ abi: ABI, functionName: 'totalStaked' })),
    readUint(TEGRIDY_STAKING_ADDRESS, encodeFunctionData({ abi: ABI, functionName: 'totalUnsettledRewards' })),
  ]);
  return balance - staked - iou;
}

/** Who holds position `id`, or null when ownerOf reverts (never minted, or burned). */
async function positionHolder(id: bigint): Promise<Address | null> {
  const data = encodeFunctionData({ abi: ABI, functionName: 'ownerOf', args: [id] });
  try {
    const word = (await anvilRpc('eth_call', [{ to: TEGRIDY_STAKING_ADDRESS, data }, 'latest'])) as Hex;
    return getAddress(`0x${word.slice(26)}`);
  } catch (e) {
    if (/revert/i.test(String(e))) return null;
    throw e; // a fork that did not answer is not "no position"
  }
}

/**
 * The lowest-id v1 position its holder can claim on the site: the id userTokenId shows
 * them, held by an account that can send (no code, or an EIP-7702 delegation), owed at
 * least the CTA's floor. Read off the fork, so a holder who already claimed (on mainnet
 * or an earlier attempt) is passed over. v1 has no public id counter: ids run from 1
 * with burned gaps, so the scan ends after 32 missing ids in a row.
 */
async function claimablePosition(): Promise<{ tokenId: bigint; holder: Address; earned: bigint }> {
  for (let id = 1n, missing = 0; missing < 32; id++) {
    const holder = await positionHolder(id);
    if (!holder) { missing++; continue; }
    missing = 0;
    const code = (await anvilRpc('eth_getCode', [holder, 'latest'])) as Hex;
    if (code !== '0x' && !code.startsWith('0xef0100')) continue;
    const shown = await readUint(
      TEGRIDY_STAKING_ADDRESS,
      encodeFunctionData({ abi: ABI, functionName: 'userTokenId', args: [holder] }),
    );
    if (shown !== id) continue;
    const earned = await earnedOf(id);
    if (earned >= CLAIM_FLOOR_WEI) return { tokenId: id, holder, earned };
  }
  throw new Error(
    'No TOWELI staking v1 position on this fork is owed 0.01 TOWELI or more by a wallet the site shows it to: ' +
      'every holder has claimed, so the claim window is spent. Retire this leg or point it at the next staking contract.',
  );
}

test.describe('Claim rewards surfaces', () => {
  test('/farm mounts the reward-bearing sections when connected', async ({ page, walletMock }) => {
    await walletMock.connect();
    await page.goto('/earn/toweli');
    // Two facts, kept apart. The heading is static, so it proves the section MOUNTED on
    // first paint; a read-derived stat proves its batch LANDED. One assertion for both
    // could not tell a missing section from a slow cold-fork read, and flaked.
    // LPFarmingSection.loading.test.tsx pins the split from the component side.
    await expect(
      page.getByRole('heading', { name: /lp farming/i }),
      'the LP farming section did not mount on /farm at all — its heading is a static ' +
        'string that needs no chain read, so this is a render failure, not RPC latency.',
    ).toBeVisible();
    // TOWELI staking v1 is closing: with no position the card is its closed line.
    await expect(page.getByRole('heading', { name: /toweli staking v1/i })).toBeVisible();
    // 30s is headroom over a cold fork's first read, whose ceiling was never measured.
    // If this times out, read useLPFarming's batch gate before touching the number.
    await expect(
      page.getByText(/total lp staked/i),
      'the LP farming section mounted but never left its loading skeleton — the ' +
        'useLPFarming batch read never resolved. For a user on a slow RPC that is a ' +
        'reward-bearing surface stuck as a shimmer. Check the multicall, not this timeout.',
    ).toBeVisible({ timeout: 30_000 });
    // No position, no claim CTA. Both claim CTAs on /farm read "Claim Rewards".
    await expect(page.getByRole('button', { name: /^claim/i })).toHaveCount(0);
  });

  /**
   * TOWELI staking v1 is in its wind-down claim window: rewardRate() is 0 and the reserve
   * holds what each position is owed, so nothing new accrues and `earned` holds still.
   * The leg claims an EXISTING position as its holder, through the page, and checks the
   * chain paid exactly `earned`. LP farming claims stay uncovered: that farm's period
   * ended 2026-06-15 unfunded, so nothing accrues there until the owner refunds it.
   */
  test('claim owed TOWELI staking v1 rewards (Anvil only)', async ({ page, walletMock }) => {
    test.skip(!onAnvil, 'ANVIL_RPC_URL unset — needs the fork job (npm run e2e)');
    test.setTimeout(120_000);

    // 0. Can the contract pay at all? A claim pays min(earned, reserve), where the reserve
    // is balance − totalStaked − IOUs; a dry one pays 0. Ask first, and fail by name.
    const reserve = await stakingRewardReserve();
    if (reserve <= 0n) {
      throw new Error(
        `TegridyStaking's reward reserve on this fork is EMPTY (balance − totalStaked − IOUs = ` +
          `${formatEther(reserve)} TOWELI), so nothing can accrue and there is nothing to claim. This is ` +
          'chain state, not this PR: it stays red until the reserve is refilled (notifyRewardAmount, owner).',
      );
    }

    // 1. The claim window itself. getReward is whenNotPaused, and only at rate 0 does
    // `earned` hold still between this read and the claim, which is what makes it exact.
    const [paused, rate] = await Promise.all([
      readUint(TEGRIDY_STAKING_ADDRESS, encodeFunctionData({ abi: ABI, functionName: 'paused' })),
      readUint(TEGRIDY_STAKING_ADDRESS, encodeFunctionData({ abi: ABI, functionName: 'rewardRate' })),
    ]);
    if (paused !== 0n) {
      throw new Error(
        'TegridyStaking v1 is paused (wind-down step 5): getReward is closed, so there is no claim to drive. ' +
          'Retire this leg or point it at the next staking contract.',
      );
    }
    if (rate !== 0n) {
      throw new Error(
        `TegridyStaking v1 rewardRate() is ${rate}, not 0: earned moves between the read and the claim, so ` +
          'this leg cannot pin the payout. It was written for the wind-down claim window (rate 0).',
      );
    }

    // 2. A real holder, found on the fork. The bridge signs as them by impersonation.
    const { tokenId, holder, earned } = await claimablePosition();
    if (reserve < earned) {
      throw new Error(
        `The reserve (${formatEther(reserve)} TOWELI) is short of position #${tokenId}'s earned ` +
          `(${formatEther(earned)}), so its claim would pay short. Chain state: refill the reserve (owner).`,
      );
    }
    await anvilRpc('anvil_setBalance', [holder, '0x8ac7230489e80000']); // 10 ETH for gas
    await walletMock.connect(holder);
    await page.goto('/earn/toweli');

    // 3. Claim, scoped to the position card: LP farming's CTA on this page has the same name.
    const heading = page.getByRole('heading', { name: /^Your Position$/i });
    await expect(heading, `position #${tokenId} (${holder}) did not surface on /earn/toweli.`)
      .toBeVisible({ timeout: 30_000 });
    const claim = heading
      .locator('xpath=ancestor::div[contains(@class,"glass-card")][1]')
      .getByRole('button', { name: /^Claim Rewards$/i });
    await expect(
      claim,
      `the claim CTA stayed disabled on position #${tokenId}, which the fork says is owed ` +
        `${formatEther(earned)} TOWELI, over the 0.01 floor. The page is misreading the position.`,
    ).toBeEnabled({ timeout: 30_000 });
    const balanceBefore = await toweliBalance(holder);
    const sent = forkTxCount(page);
    await claim.click();
    const hash = await expectMinedSuccessfully(page, 'claim', sent);

    // 4. The chain paid exactly `earned`, from the staking contract, and the debt cleared.
    const { logs } = (await anvilRpc('eth_getTransactionReceipt', [hash])) as { logs: Log[] };
    const paid = parseEventLogs({
      abi: ABI,
      eventName: 'Transfer',
      logs: logs.filter((l) => isAddressEqual(l.address, TOWELI_ADDRESS)),
    })
      .filter((e) => isAddressEqual(e.args.from, TEGRIDY_STAKING_ADDRESS) && isAddressEqual(e.args.to, holder))
      .reduce((sum, e) => sum + e.args.value, 0n);
    expect(paid, `claim ${hash}: TOWELI sent from staking to the holder`).toBe(earned);
    expect((await toweliBalance(holder)) - balanceBefore, `claim ${hash}: the holder's TOWELI gain`).toBe(earned);
    expect(await earnedOf(tokenId), `claim ${hash}: position #${tokenId} still owed after paying`).toBe(0n);

    // 5. The page's receipt names this transaction and the amount the chain paid.
    await expectTxReceipt(page, 'claim', { hash });
    await expect(
      page.getByRole('dialog').getByText(`${formatTokenAmount(formatEther(earned), 6)} TOWELI`, { exact: true }),
      `claim ${hash}: the receipt does not show the ${formatEther(earned)} TOWELI the chain paid.`,
    ).toBeVisible();
  });
});
