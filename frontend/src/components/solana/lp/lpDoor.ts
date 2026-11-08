import { createContext, useContext } from 'react';

/**
 * The place above PoolsPage's hero where the LP door is drawn, and how the LP section claims it.
 * The page holds the place with a waiting frame from its first frame; the section claims it when
 * it mounts and draws its own door there (LpDoorFrame), so the page's frame goes.
 */
export interface LpDoorAnchor {
  at: HTMLElement | null;
  claim(): void;
}

/** The slot inside the door's frame. Whatever draws there calls `hold` while it is drawn. */
export interface LpDoorPlace {
  slot: HTMLElement | null;
  hold(): () => void;
}

export const LpDoorContext = createContext<LpDoorPlace | null>(null);

/** True inside the door: a panel drawn there is already where the visitor is, so it scrolls nothing. */
export const InDoorContext = createContext(false);

export const useInDoor = (): boolean => useContext(InDoorContext);
