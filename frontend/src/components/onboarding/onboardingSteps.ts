// First-run onboarding content, derived from the gates rather than written alongside them.
//
// THE FAILURE THIS PREVENTS. An onboarding flow is the one surface a newcomer reads
// literally, and it is also the surface furthest from the code that decides what is live.
// Several contracts in constants.ts are the zero address on purpose (GaugeController,
// VoteIncentives, CommunityGrants, MemeBountyBoard, the airdrop/vesting/lock rails,
// restaking, the Pro Pass), and every surface that touches them renders a placeholder. A
// welcome screen that routes a first-time visitor at one of those sends them to a wall on
// their first click, having just promised it worked.
//
// So no route here is a literal in the copy. Every destination is a SURFACE with a
// liveness predicate, `liveSurfaces()` filters them at read time, and the steps are built
// from what survives. Un-gating a contract adds its destination with no edit to this file;
// re-gating one removes it the same way. onboardingSteps.test.ts pins both halves,
// including that the copy never names a dark surface in prose either — a paragraph that
// promises a feature is a promise whether or not it carries a link.

import {
  TEGRIDY_ROUTER_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  TEGRIDY_NFT_LENDING_ADDRESS,
  isDeployed,
} from '../../lib/constants';
import { isLauncherEnabled } from '../../lib/launcher/config';
import { isSolanaSwapLive } from '../../lib/solana';
import { isToweliVoice, VENUE } from '../../lib/arrival';

export type OnboardingSurfaceId =
  | 'trade'
  | 'farm'
  | 'solana'
  | 'scan'
  | 'launch'
  | 'nft-finance'
  | 'risks';

export interface OnboardingSurface {
  id: OnboardingSurfaceId;
  /** In-app route. External destinations are deliberately not expressible here. */
  route: string;
  label: string;
  /** One line on what the user would actually do there. */
  blurb: string;
  /** Reads the same gate the destination page reads. Never a hardcoded true for a contract. */
  isLive: () => boolean;
}

/**
 * Every destination onboarding is allowed to name.
 *
 * `scan` and `risks` answer true unconditionally, and that is a claim worth stating: both
 * are read-only pages with no contract behind them — the scanner self-gates its own
 * sections when holder data is unavailable, and the risk page is static text. Nothing else
 * in this table may be hardcoded.
 */
export const ONBOARDING_SURFACES: readonly OnboardingSurface[] = [
  {
    id: 'trade',
    route: '/swap',
    label: 'Trade',
    blurb: 'Swap on the native DEX or across the routed aggregators, with the quote you are shown.',
    isLive: () => isDeployed(TEGRIDY_ROUTER_ADDRESS),
  },
  {
    id: 'farm',
    route: '/farm',
    label: 'Farm',
    blurb: 'Stake and lock TOWELI. Longer locks weigh more; the boost is computed on-chain.',
    isLive: () => isDeployed(TEGRIDY_STAKING_ADDRESS),
  },
  {
    id: 'scan',
    route: '/scan',
    label: 'Scan a token',
    blurb: 'Read a token’s holder concentration and deployer history before you buy it. Free, no wallet.',
    isLive: () => true,
  },
  {
    id: 'solana',
    route: '/solana',
    label: 'Solana swap',
    blurb: 'Swap Solana tokens through Jupiter from the same venue.',
    isLive: () => isSolanaSwapLive(),
  },
  {
    id: 'launch',
    route: '/launch',
    label: 'Launch a token',
    blurb: 'Deploy a token through the launch rail, with its disclosures published on a permanent record.',
    isLive: () => isLauncherEnabled(),
  },
  {
    id: 'nft-finance',
    route: '/nft-finance',
    label: 'NFT finance',
    blurb: 'Borrow against an NFT, or trade one through the pooled market.',
    isLive: () => isDeployed(TEGRIDY_NFT_LENDING_ADDRESS),
  },
  {
    id: 'risks',
    route: '/risks',
    label: 'Risk disclosure',
    blurb: 'The full list of what can go wrong here, in one place.',
    isLive: () => true,
  },
];

/** The surfaces whose own gate says they are usable right now. */
export function liveSurfaces(): OnboardingSurface[] {
  return ONBOARDING_SURFACES.filter((s) => s.isLive());
}

export interface OnboardingStep {
  id: string;
  title: string;
  /** Paragraphs. Plain strings — this flow renders no markup a translator could break. */
  body: readonly string[];
  /** Where this step can send someone. Already filtered to live surfaces. */
  actions: OnboardingSurface[];
  /**
   * The funding step mounts the on-ramp panel, which has its own configured /
   * not-configured states. Marked here rather than matched on `id` by the renderer.
   */
  showOnramp?: boolean;
}

function pick(...ids: OnboardingSurfaceId[]): OnboardingSurface[] {
  const live = new Map(liveSurfaces().map((s) => [s.id, s]));
  return ids.map((id) => live.get(id)).filter((s): s is OnboardingSurface => s !== undefined);
}

/**
 * The flow. Four steps, in the order a newcomer actually hits the walls:
 * what is this -> how do I get funds -> what can go wrong -> what do I do first.
 *
 * The risk step is third rather than last on purpose: last is where a reader skims, and
 * the disclosure is not decoration. Nothing in this copy names a rate, an APY, or a return
 * — every figure a user sees must come from a live read on the page that owns it.
 */
export function onboardingSteps(): OnboardingStep[] {
  return [
    {
      id: 'what',
      title: 'What this place is',
      body: [
        `${isToweliVoice() ? 'Tegridy Farms' : VENUE.name} is a DeFi venue on Ethereum and Solana. You can swap tokens, stake TOWELI on Ethereum, and read a token’s holder concentration and deployer history before you touch it.`,
        'It is not a bank, a broker, or a custodian. Nothing here holds your funds: you sign transactions from your own wallet and they settle on-chain, where anyone can check them.',
      ],
      actions: pick('scan'),
    },
    {
      id: 'funding',
      title: 'Getting funds in',
      body: [
        'Everything on Ethereum costs gas, which is paid in ETH. Without ETH in your wallet, nothing here works — that is the first wall most people hit.',
        'You can send ETH from an exchange or another wallet you already control. If a card partner is configured on this deployment, you can also buy directly; the purchase happens on the partner’s own site, under their licence, and this venue never sees your card or identity documents.',
      ],
      actions: [],
      showOnramp: true,
    },
    {
      id: 'risks',
      title: 'What can go wrong',
      body: [
        'This is experimental software. The contracts can hold bugs, an audit does not prove their absence, and a loss here is usually permanent — there is no chargeback, no support desk that can reverse a signed transaction, and no insurance.',
        'Token prices can go to zero, including TOWELI. Locked stake is locked: early exit carries an on-chain penalty. Never commit money you need back.',
        'Parts of this venue are switched off on purpose and render as placeholders rather than pretending to work. Anything you are routed to from here is live; anything showing a placeholder is not, and no timeline is promised for it.',
      ],
      actions: pick('risks'),
    },
    {
      id: 'first-move',
      title: 'Your first move',
      body: [
        'Pick one. These are the surfaces that are actually running right now — the list is built from the same gates the pages themselves read, so it cannot promise you something dark.',
      ],
      actions: pick('scan', 'trade', 'farm', 'solana', 'launch', 'nft-finance'),
    },
  ];
}
