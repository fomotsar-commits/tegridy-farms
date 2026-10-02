import type { PublicKey } from '@solana/web3.js';
import { formatTokenAmount } from '../../../lib/launcher/solana/curve';
import { Row } from './ui';
import { sharePercent } from './uiFormat';
import type { Fact, MakerBuy, PlantMoved } from './facts';

// The maker's plates (island ruling 3, 2026-10-01): the maker's create-buy as a share of
// the supply at birth, with the wallet, its lock, and the plant, all read from the launch
// transaction. A failed read says so in words, never as 0 or 0%. The list rows show the
// same maker figure (MakerBuyLines), so the two never disagree.

/** Half the plant, 50,000 $BAYLA in base units (6 decimals); write/plant.ts holds the source. */
const PLANT_HALF_RAW = 50_000_000_000n;
const BAYLA_DECIMALS = 6;

const bayla = (v: bigint) =>
  `${v < 0n ? '-' : ''}${formatTokenAmount(v < 0n ? -v : v, BAYLA_DECIMALS, BAYLA_DECIMALS).text}`;

function plantLine(plant: Fact<PlantMoved>): string {
  if (plant.kind === 'unreadable') return 'Could not read whether this launch carried a plant.';
  const { burned, toWorkshop } = plant.value;
  if (burned === PLANT_HALF_RAW && toWorkshop === PLANT_HALF_RAW) {
    return "Plant: 50,000 $BAYLA burned and 50,000 $BAYLA to the island's Workshop, in the launch transaction.";
  }
  if (burned === 0n && toWorkshop === 0n) return 'No plant: its launch transaction carried none.';
  return `Its launch transaction moved $BAYLA, but not as a plant: ${bayla(burned)} burned, ${bayla(toWorkshop)} to the island's Workshop.`;
}

/** The maker's figure, the wallet when given, and apart from them what other wallets got in the same transaction. */
export function MakerBuyLines({
  buy,
  decimals,
  maker = null,
}: {
  buy: Fact<MakerBuy>;
  decimals: number | null;
  maker?: PublicKey | null;
}) {
  const wallet = maker && <Row label="Maker's wallet" value={maker.toBase58()} />;
  const share = buy.kind === 'ok' ? sharePercent(buy.value.tokens, buy.value.birthSupply) : null;
  if (buy.kind === 'unreadable' || share === null) {
    return (
      <>
        <p className="text-white/75">
          Could not read the maker&apos;s create-buy right now. This is our read failing, not a finding about the launch.
        </p>
        <p className="text-white/40 text-[10px]">
          {buy.kind === 'unreadable' ? buy.detail : 'the supply at birth could not be read'}
        </p>
        {wallet}
      </>
    );
  }
  const { tokens, othersTokens, others, birthSupply } = buy.value;
  const amount = formatTokenAmount(tokens, decimals);
  return (
    <>
      <p className="text-white/75">
        {tokens === 0n
          ? 'The maker bought nothing in the launch transaction.'
          : `The maker's create-buy: ${share} of the supply (${amount.text} ${amount.isBaseUnits ? 'base units' : 'tokens'}), bought in the launch transaction, before anyone else could buy.`}
      </p>
      {wallet}
      {others > 0 && (
        <p className="text-white/75">
          {`Other wallets got ${sharePercent(othersTokens, birthSupply)} of the supply in the same transaction (${others} ${others === 1 ? 'wallet' : 'wallets'}).`}
        </p>
      )}
    </>
  );
}

/** The launch page's block, right under the token address: figure, wallet, lock, plant. */
export function MakerCreateBuy({
  maker,
  buy,
  plant,
  decimals,
}: {
  /** The launch account's creator; `null` when that account could not be read. */
  maker: PublicKey | null;
  buy: Fact<MakerBuy>;
  plant: Fact<PlantMoved>;
  decimals: number | null;
}) {
  return (
    <div className="space-y-1" data-testid="maker-create-buy">
      <MakerBuyLines buy={buy} decimals={decimals} maker={maker} />
      <p className="text-white/75">No lock: this launcher has no way to lock a maker&apos;s tokens.</p>
      <p className="text-white/75">{plantLine(plant)}</p>
    </div>
  );
}
