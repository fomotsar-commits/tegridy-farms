import { useState } from 'react';
import { useAccount } from 'wagmi';
import { formatEther } from 'viem';
import { POSITION_MARKET_ADDRESS, isDeployed } from '../../lib/constants';
import {
  ORDER_STATUS,
  netProceeds,
  usePositionMarketActions,
  usePositionMarketCapacity,
  usePositionMarketEscrowRewards,
  usePositionMarketOrder,
} from '../../hooks/usePositionMarket';
import { usePositionMarketFillability } from '../../hooks/usePositionMarketFillability';
import { FillEligibilityNotice, FillButton } from './FillEligibilityNotice';

/**
 * Escrowed secondary market for veTOWELI staking positions.
 *
 * A lock has no pre-maturity exit; this is the exit. A seller escrows the
 * position NFT, a buyer pays, and the position moves against payment in one
 * transaction.
 *
 * WHAT THIS SURFACE DOES NOT DO: it never prices a position. There is no "fair
 * value", no floor estimate, no implied APR. The listing card shows what the
 * chain says about the position — principal, lock end, boost — and the price the
 * seller chose. Whether that price is good is the buyer's problem, and a modelled
 * number here would only launder our guess as a fact.
 *
 * Gated on `isDeployed(POSITION_MARKET_ADDRESS)`; while that is the zero address
 * this renders the not-yet state and asks the chain for nothing.
 */
export function PositionMarketPanel({ orderId }: { orderId?: bigint }) {
  if (!isDeployed(POSITION_MARKET_ADDRESS)) {
    return (
      <section
        style={{
          padding: '1.25rem',
          border: '1px dashed rgba(148,163,184,0.35)',
          borderRadius: 12,
          fontSize: '0.9rem',
          lineHeight: 1.5,
        }}
      >
        <strong style={{ display: 'block', marginBottom: '0.4rem' }}>Position market — not deployed</strong>
        <span style={{ opacity: 0.75 }}>
          The escrowed order book for staking positions is written and tested but has not been deployed. There are no
          listings to show, and none are being hidden — the contract does not exist yet.
        </span>
      </section>
    );
  }
  return <LiveMarket orderId={orderId} />;
}

function LiveMarket({ orderId }: { orderId?: bigint }) {
  const { address } = useAccount();
  const [recipient, setRecipient] = useState<string>('');
  const capacity = usePositionMarketCapacity();
  const { order, unavailableReason } = usePositionMarketOrder(orderId);
  const escrowRewards = usePositionMarketEscrowRewards();
  const actions = usePositionMarketActions();

  const chosenRecipient = (recipient || address || '') as `0x${string}` | '';
  const verdict = usePositionMarketFillability(
    orderId,
    chosenRecipient === '' ? undefined : (chosenRecipient as `0x${string}`),
  );

  return (
    <section style={{ display: 'grid', gap: '1rem' }}>
      <CapacityLine capacity={capacity} />

      {unavailableReason && (
        <p style={{ opacity: 0.7, fontSize: '0.85rem' }} role="status">
          {unavailableReason}
        </p>
      )}

      {order && order.status === ORDER_STATUS.Open && (
        <article style={{ display: 'grid', gap: '0.75rem', padding: '1rem', border: '1px solid rgba(148,163,184,0.25)', borderRadius: 12 }}>
          <header style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
            <span style={{ fontWeight: 700 }}>Position #{order.tokenId.toString()}</span>
            <span style={{ fontWeight: 700 }}>{formatEther(order.price)} ETH</span>
          </header>

          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 0.75rem', fontSize: '0.85rem', margin: 0 }}>
            <dt style={{ opacity: 0.65 }}>Seller</dt>
            <dd style={{ margin: 0 }}>{order.seller}</dd>
            <dt style={{ opacity: 0.65 }}>Seller nets</dt>
            <dd style={{ margin: 0 }}>
              {(() => {
                const net = netProceeds(order.price, order.feeBps, order.feeRecipient);
                return net === null ? 'unknown' : `${formatEther(net)} ETH`;
              })()}
            </dd>
          </dl>

          <label style={{ display: 'grid', gap: '0.3rem', fontSize: '0.8rem' }}>
            <span style={{ opacity: 0.75 }}>
              Deliver to — a wallet that already holds a staking position cannot receive another
            </span>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder={address ?? '0x…'}
              spellCheck={false}
              style={{
                padding: '0.55rem 0.7rem',
                borderRadius: 8,
                border: '1px solid rgba(148,163,184,0.35)',
                background: 'transparent',
                color: 'inherit',
                fontFamily: 'monospace',
                fontSize: '0.8rem',
              }}
            />
          </label>

          <FillEligibilityNotice verdict={verdict} />

          <FillButton
            verdict={verdict}
            priceLabel={`${formatEther(order.price)} ETH`}
            disabled={actions.isPending || chosenRecipient === ''}
            onFill={() => actions.fill(order.orderId, chosenRecipient as `0x${string}`, order.price)}
          />
        </article>
      )}

      <EscrowRewardsLine owed={escrowRewards.owed} reason={escrowRewards.unavailableReason} onClaim={actions.claimEscrowRewards} />
    </section>
  );
}

/**
 * The escrow cap is a protocol fact, not a product limit: the market is a plain
 * contract holder on TegridyStaking, which caps any holder at 50 positions. A
 * seller deserves to know the book is full before their listing reverts.
 */
function CapacityLine({ capacity }: { capacity: ReturnType<typeof usePositionMarketCapacity> }) {
  if (!capacity.known) {
    return (
      <p style={{ opacity: 0.7, fontSize: '0.8rem', margin: 0 }} role="status">
        Escrow capacity unavailable — could not read the book size.
      </p>
    );
  }
  return (
    <p style={{ opacity: capacity.full ? 1 : 0.7, fontSize: '0.8rem', margin: 0 }} role="status">
      {capacity.used} of {capacity.cap} escrow slots in use
      {capacity.full
        ? ' — the book is full. TegridyStaking caps any holder at this many positions, so no new listing can be escrowed until one clears.'
        : '.'}
    </p>
  );
}

/**
 * Rewards keep accruing to a position while it sits in escrow, and the staking
 * contract settles them to whoever holds the NFT — the market. They are booked
 * back to the seller and claimed here. Zero and unknown are drawn differently.
 */
function EscrowRewardsLine({
  owed,
  reason,
  onClaim,
}: {
  owed: bigint | null;
  reason: string | null;
  onClaim: () => void;
}) {
  if (reason) {
    return (
      <p style={{ opacity: 0.7, fontSize: '0.8rem', margin: 0 }} role="status">
        Escrow yield: {reason}
      </p>
    );
  }
  if (owed === null) return null;
  if (owed === 0n) {
    return (
      <p style={{ opacity: 0.7, fontSize: '0.8rem', margin: 0 }}>
        No escrow yield owed to this wallet.
      </p>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.85rem' }}>
      <span>{formatEther(owed)} TOWELI earned while your position sat in escrow.</span>
      <button type="button" onClick={onClaim} style={{ padding: '0.4rem 0.8rem', borderRadius: 8, fontWeight: 600 }}>
        Claim
      </button>
    </div>
  );
}
