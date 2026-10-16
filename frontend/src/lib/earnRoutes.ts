import { BUNGALOWS, DEFAULT_BUNGALOW_ID } from './bungalows';

/**
 * Earn's addresses (2026-09-30). `/earn/<id>` is one pool, by registry id. `/earn` opens the
 * active room's pool (owner, 2026-10-15: Lock shows the bungalow selected, not every
 * bungalow), and is the list of every pool for the venue itself, with no room chosen.
 * `/earn?pools=all` is the list from inside any room: each pool links there, so the list is
 * always one press away (the owner's 2026-09-30 report: from inside a pool there was no way
 * back to it).
 */
export const EARN_PATH = '/earn';

/** The list of every pool, whatever room is active. */
export const ALL_POOLS_PATH = `${EARN_PATH}?pools=all`;

/** Is this `/earn` query the list of every pool? */
export function wantsAllPools(search: string): boolean {
  return new URLSearchParams(search).get('pools') === 'all';
}

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
