/**
 * Per-bungalow DOOR art overrides — written by /door-studio.
 *
 * Key format: the bungalow id alone (e.g. "qr"). One door per resident.
 *
 * `artId` resolves against EVERY bungalow's pool and then the classic ART map,
 * because a door is the island's own shop window: the right picture for the QR
 * card may well come from another resident's drop, or from classic art. See
 * doorArt.ts for the resolver and the id-uniqueness guarantee it relies on.
 *
 * Surfaces NOT listed here fall back to the `thumb` / `thumbPosition` written on
 * the registry entry in bungalows.ts, which is where every door started.
 *
 * Do not hand-edit during a studio session — the studio overwrites this file on save.
 */
export type DoorArtOverride = {
  artId: string;
  objectPosition?: string;
};

export const DOOR_ART_OVERRIDES: Record<string, DoorArtOverride> = {
  "bayla": { artId: "B9B9259D-64AB-4EC6-B76F-257124881E40", objectPosition: "50% 33%" },
  "bnkr": { artId: "CA40C4F4-E7F8-4D95-AFD1-00C07D87F530", objectPosition: "50% 74%" },
  "bobo": { artId: "F2E651C2-61A3-4681-B06D-D84A11C5C589", objectPosition: "50% 49%" },
  "brainlet": { artId: "B5D288A5-2281-4654-A9E0-E197E5AE4246", objectPosition: "50% 33%" },
  "drb": { artId: "3084FB24-7B2F-4221-8E20-EDF772741650", objectPosition: "50% 48%" },
  "jbm": { artId: "335FCE30-99E1-446C-AF41-832BD3903524", objectPosition: "50% 41%" },
  "mfer": { artId: "63D92BE3-D739-4092-9785-200B1403A40B", objectPosition: "50% 27%" },
  "nb1": { artId: "naka31", objectPosition: "50% 28%" },
  "pepe": { artId: "13924936-60C5-4676-8BDC-36A5E79EE45A", objectPosition: "50% 43%" },
  "qr": { artId: "7F184A9A-142E-4639-8D01-8225980F1A9F", objectPosition: "50% 4%" },
  "rizz": { artId: "B40345D2-9FCF-4110-979A-572B2CE7FE38", objectPosition: "50% 41%" },
  "soy": { artId: "F8B216D6-EA7F-4BA1-9F19-06E33770EAFB", objectPosition: "50% 43%" },
  "toweli": { artId: "drop10", objectPosition: "50% 16%" },
};
