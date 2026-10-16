import { BUNGALOWS, DEFAULT_BUNGALOW_ID } from './bungalows';

/**
 * Earn's addresses (2026-09-30). `/earn` is the list of every pool, whatever
 * room is active; `/earn/<id>` is one pool, by registry id. Until then both
 * were one address, /farm, and the active ROOM picked what it showed — so a
 * visitor inside one pool could not get back to the list: the Earn word, the
 * Staking tab and a reload all landed on the same pool.
 */
export const EARN_PATH = '/earn';

/** One pool's page. `id` is a registry id: 'toweli', 'bayla', … */
export function earnPoolPath(id: string): string {
  return `${EARN_PATH}/${id}`;
}

/** TOWELI's pool, the classic farm. */
export const TOWELI_EARN_PATH = earnPoolPath(DEFAULT_BUNGALOW_ID);

/** Does `/earn/<id>` name a pool page? Only a live resident's id does. */
export function isEarnPoolId(id: string): boolean {
  return BUNGALOWS.some((b) => b.id === id && b.live);
}

/**
 * Where an old `/farm` link goes. /farm meant "the active room's pool", or the
 * list with no room active, so it keeps that meaning: `room` is what
 * getActiveBungalow() reads (?bungalow= first, then storage). Its ?bungalow=
 * is spent on choosing the pool; any other query and the hash ride along.
 */
export function legacyFarmTarget(search: string, hash: string, room: { id: string } | null): string {
  const params = new URLSearchParams(search);
  params.delete('bungalow');
  const query = params.toString();
  const path = room && isEarnPoolId(room.id) ? earnPoolPath(room.id) : EARN_PATH;
  return `${path}${query ? `?${query}` : ''}${hash}`;
}
