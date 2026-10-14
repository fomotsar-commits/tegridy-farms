/**
 * Jungle Bay's music: plain outbound links, never an embed, a player or a script.
 * index.html's JSON-LD names the two artist pages as the collective's sameAs, and
 * components/IslandSound.test.tsx pins them to these, so the two cannot drift apart.
 */
export const ISLAND_SOUND = {
  spotify: 'https://open.spotify.com/artist/0tviFMxqVFawAkZmsLDjOV',
  youtube: 'https://www.youtube.com/@junglebayisland',
  /** The featured track, Memetic Sorcerer. */
  track: 'https://open.spotify.com/track/1KJh00jBJSaPwtHgJk6vPb',
} as const;
