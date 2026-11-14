import { useLocation } from 'react-router-dom';
import { baylaLine, type BaylaLine as Line } from '../lib/baylaLine';
import { getActiveBungalow } from '../lib/bungalows';
import { useActiveBungalowId } from '../hooks/useActiveBungalowId';
import { useLastReading } from '../lib/heat/heatStore';
import { heatLaunchFloor } from '../lib/heat/heatGateConfig';
import { isLaunchDoorOpen } from '../lib/launcher/door';
import { useLanded } from '../lib/landed';
import { LAUNCH_SECTION, poolsRoute } from '../lib/navConfig';
import { isSolanaSwapLive } from '../lib/solana';
import { useRoomSlow } from '../lib/solana/lp/roomPrice';
import { useCurrentScreenMove } from '../lib/screenMove';
import { sheetHref } from '../lib/sheet';
import { roomOpensSheet } from '../lib/sheetRooms';

/** The quiet button (answer twenty-five, §2): the same press, an edge and its words, no fill. */
export const QUIET_BUTTON_STYLE = { background: 'transparent', border: '1px solid rgba(255,255,255,0.25)', color: 'rgba(255,255,255,0.78)' } as const;

/**
 * Her line for this screen, as the header draws it and the sheet quotes it: the wallet read
 * last, the room, a landed action, the room pool's price when the shared list is behind, and
 * the screen's own green move. Add and Start the clock open the sheet over the page (build 3).
 */
export function useBaylaLine(): Line {
  const location = useLocation();
  useActiveBungalowId();
  const reading = useLastReading();
  const landed = useLanded();
  const screenMove = useCurrentScreenMove();
  const room = getActiveBungalow();
  const solanaPool = room !== null && room.chain === 'solana' && !!room.address;
  const slow = useRoomSlow(solanaPool ? room.address! : null);
  return baylaLine({
    reading,
    room: room ? { coin: room.symbol, solanaPool } : null,
    floor: heatLaunchFloor(),
    doorOpen: isLaunchDoorOpen(),
    landed: landed?.kind ?? null,
    slow,
    screenMove,
    to: {
      pools: solanaPool && room.venueSolPool ? sheetHref(location.pathname, location.search, 'add') : poolsRoute(),
      // In a room on Ethereum or Base the sheet opens on that network (ActionSheet reads the room's).
      buy: isSolanaSwapLive() || roomOpensSheet(room, 'buy') ? sheetHref(location.pathname, location.search, 'buy') : '/swap',
      launch: LAUNCH_SECTION.primaryTo ?? LAUNCH_SECTION.hub,
      read: '/',
      pick: '/#hall',
      receipt: '/dashboard',
    },
  });
}
