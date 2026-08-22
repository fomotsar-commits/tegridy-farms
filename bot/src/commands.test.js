// The four rules in commands.js, each with a test that names it.

import { describe, it, expect, vi } from "vitest";
import { handleMessage, parseCommand } from "./commands.js";
import { VENUE_FAIL } from "./venueClient.js";
import { INDEXER_UNAVAILABLE } from "./indexerClient.js";

const CHAT_REF = "b".repeat(64);
const WALLET = `0x${"9".repeat(40)}`;

const cfg = {
  appOrigin: "https://memetic.fun",
  venueOrigin: "https://memetic.fun",
  indexerUrl: null,
  indexerUrlRaw: null,
};

/** Every read the router can make, defaulted to a working venue. */
function deps(overrides = {}) {
  return {
    cfg: overrides.cfg ?? cfg,
    venue: {
      beginLink: vi.fn(async () => ({
        ok: true,
        data: { code: "ABCDEFGHJK", expiresAt: new Date(Date.now() + 600_000).toISOString() },
      })),
      readLink: vi.fn(async () => ({ ok: true, data: { linked: true, wallet: WALLET } })),
      revokeLink: vi.fn(async () => ({ ok: true, data: { removed: 1 } })),
      readHeat: vi.fn(async () => ({ ok: true, data: { degrees: 400, tier: "molten", as_of_unix: 1_760_000_000 } })),
      ...(overrides.venue ?? {}),
    },
    indexer: {
      recentSwaps: vi.fn(async () => ({ ok: true, items: [], syncedBlock: 25_300_000 })),
      ...(overrides.indexer ?? {}),
    },
  };
}

const say = (text, d = deps()) => handleMessage({ text, chatRef: CHAT_REF }, d);

const PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident";

describe("RULE 1 — the secret check runs before anything is parsed", () => {
  it("warns on a bare pasted phrase", async () => {
    const reply = await say(PHRASE);
    expect(reply.text).toMatch(/recovery phrase/i);
  });

  it("warns on a phrase pasted after a command, instead of falling into help", async () => {
    // The precise failure: `/import <phrase>` routed as an unknown command would
    // print the help text, scroll the phrase up the chat, and say nothing about it.
    const reply = await say(`/import ${PHRASE}`);
    expect(reply.text).toMatch(/recovery phrase/i);
    expect(reply.text).not.toMatch(/I do not have that command/);
  });

  it("does not consult the venue at all when a secret is detected", async () => {
    const d = deps();
    await handleMessage({ text: PHRASE, chatRef: CHAT_REF }, d);
    expect(d.venue.readLink).not.toHaveBeenCalled();
    expect(d.venue.beginLink).not.toHaveBeenCalled();
  });
});

describe("RULE 2 — nothing that moves value is executed", () => {
  const commands = ["/buy", "/sell", "/snipe", "/withdraw", "/send", "/approve", "/wallet", "/import", "/export"];

  for (const c of commands) {
    it(`${c} refuses and explains, rather than gating or queueing`, async () => {
      const reply = await say(`${c} 0.5 eth`);
      expect(reply.text).toMatch(/holds no key/i);
      expect(reply.text).toContain("https://memetic.fun/swap?tab=swap");
      // No "coming soon", no "not yet enabled" — the capability is absent by
      // decision, and telling a user to wait for it would be a promise.
      expect(reply.text).not.toMatch(/coming soon|not yet|enable/i);
    });
  }

  it("names the reason in terms of what happened to the bots that did it", async () => {
    expect((await say("/buy")).text).toMatch(/drained/i);
  });

  it("makes no network call to execute anything", async () => {
    const d = deps();
    await handleMessage({ text: "/buy 1 eth", chatRef: CHAT_REF }, d);
    expect(d.venue.beginLink).not.toHaveBeenCalled();
    expect(d.indexer.recentSwaps).not.toHaveBeenCalled();
  });
});

describe("RULE 3 — an unread source is never a zero", () => {
  it("a missing migration does NOT become 'this chat is not linked'", async () => {
    const d = deps({
      venue: {
        readLink: vi.fn(async () => ({
          ok: false,
          reason: VENUE_FAIL.NOT_READY,
          detail: "The Telegram link table does not exist on this deployment.",
          operatorStep: "Apply 020_telegram_links.sql",
        })),
      },
    });
    const reply = await say("/status", d);
    expect(reply.text).toMatch(/could not read whether this chat is linked/i);
    expect(reply.text).not.toMatch(/is not linked to any wallet/);
    expect(reply.text).toContain("Apply 020_telegram_links.sql");
  });

  it("an unhosted indexer does NOT become 'you have no swaps'", async () => {
    const d = deps({
      indexer: {
        recentSwaps: vi.fn(async () => ({
          ok: false,
          reason: INDEXER_UNAVAILABLE.NOT_CONFIGURED,
          detail: "This venue has no indexer hosted yet.",
        })),
      },
    });
    const reply = await say("/history", d);
    expect(reply.text).toMatch(/not the same as you having none/i);
    expect(reply.text).not.toMatch(/No venue-routed swaps/);
  });

  it("a backfilling indexer is reported as catching up, not as an empty history", async () => {
    const d = deps({
      indexer: {
        recentSwaps: vi.fn(async () => ({
          ok: false,
          reason: INDEXER_UNAVAILABLE.BACKFILLING,
          detail: "The indexer is still catching up on chain history.",
        })),
      },
    });
    expect((await say("/history", d)).text).toMatch(/still catching up/i);
  });

  it("an empty READY page IS an answer, and states what the table does not cover", async () => {
    const reply = await say("/history");
    expect(reply.text).toMatch(/No venue-routed swaps/);
    // The scope caveat from useIndexedSwaps.ts, carried into chat: an empty
    // venue-router table is not "this wallet has never traded".
    expect(reply.text).toMatch(/trades made anywhere else are not counted/i);
  });

  it("a heat outage is not rendered as a cold wallet", async () => {
    const d = deps({
      venue: {
        readHeat: vi.fn(async () => ({
          ok: false,
          reason: VENUE_FAIL.UNREACHABLE,
          detail: "The heat oracle is unavailable. This is not a reading of zero.",
        })),
      },
    });
    const reply = await say("/heat", d);
    expect(reply.text).toMatch(/not a reading of zero/i);
    expect(reply.text).not.toMatch(/0°/);
  });

  it("a failed unlink says the binding is STILL IN PLACE", async () => {
    // A user told they are unlinked stops watching a binding that is live.
    const d = deps({
      venue: {
        revokeLink: vi.fn(async () => ({
          ok: false,
          reason: VENUE_FAIL.UNREACHABLE,
          detail: "The venue did not answer.",
        })),
      },
    });
    const reply = await say("/unlink", d);
    expect(reply.text).toMatch(/NOT removed/);
    expect(reply.text).toMatch(/still in place/i);
  });

  it("heat forwards the island's own reckoning date and does not call it ours", async () => {
    const reply = await say("/heat");
    expect(reply.text).toMatch(/Jungle Bay Island/);
    expect(reply.text).toMatch(/not a yield, not a price/i);
  });
});

describe("RULE 4 — no reply echoes the input", () => {
  it("an unknown command is not quoted back", async () => {
    const reply = await say("/wubbalubbadubdub");
    expect(reply.text).not.toContain("wubbalubbadubdub");
  });

  it("a secret-shaped message never appears in the reply", async () => {
    const reply = await say(`/import ${PHRASE}`);
    for (const word of PHRASE.split(" ")) {
      expect(reply.text.split(/\s+/)).not.toContain(word);
    }
  });
});

describe("linking", () => {
  it("hands back a code inside a link to the app, and says what signing does not do", async () => {
    const reply = await say("/link");
    expect(reply.text).toContain("https://memetic.fun/alerts?tglink=ABCDEFGHJK");
    // The sentence that stops a user learning to approve anything a bot sends.
    expect(reply.text).toMatch(/does not approve any spending/i);
  });

  it("refuses to re-home an already-linked chat and says how to change it", async () => {
    const d = deps({
      venue: {
        beginLink: vi.fn(async () => ({
          ok: false,
          reason: VENUE_FAIL.REJECTED,
          code: "already-linked",
          wallet: WALLET,
          detail: "already",
        })),
      },
    });
    const reply = await say("/link", d);
    expect(reply.text).toMatch(/already linked/i);
    expect(reply.text).toMatch(/\/unlink/);
  });

  it("status prints the capability report, including the one that is off by design", async () => {
    const reply = await say("/status");
    expect(reply.text).toContain(WALLET);
    expect(reply.text).toMatch(/Trading from chat/);
    expect(reply.text).toMatch(/holds no key/i);
  });
});

describe("help", () => {
  it("is what an empty or unrecognised message gets, and states the hard promise", async () => {
    for (const text of ["", "hello", "/start", "/help"]) {
      const reply = await say(text);
      expect(reply.text).toMatch(/never asks for a recovery phrase/i);
    }
  });
});

describe("parseCommand", () => {
  it("strips the @botname Telegram appends in groups", () => {
    expect(parseCommand("/status@tegridy_bot").command).toBe("status");
  });

  it("lower-cases and splits arguments", () => {
    expect(parseCommand("/HEAT 0xAbC")).toEqual({ command: "heat", args: ["0xAbC"], text: "/HEAT 0xAbC" });
  });

  it("treats plain text as no command", () => {
    expect(parseCommand("gm").command).toBeNull();
  });
});
