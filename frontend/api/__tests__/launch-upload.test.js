// @vitest-environment node
// api/launch-upload.js: the picture + details pinning endpoint, and its orphan sweep.
//
// Pinata and the Solana RPC are replaced by a fake fetch; everything else is real,
// including the ed25519 signature check and the browser client (upload.ts), which
// is driven against this handler end to end so the two cannot disagree about the
// signed message.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { PublicKey } from "@solana/web3.js";
import {
  buildMetadataJson,
  detailsDigestInput,
  sha256Hex,
  uploadAuthMessage,
} from "../../src/lib/launchMetadata/validate.js";
import { PNG_1X1, SVG, jpeg, png } from "../../src/lib/launchMetadata/testImages.fixture";

const rl = vi.hoisted(() => ({ ip: true, wallet: true, global: true, calls: [] }));
vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async (_req, res, opts) => {
    rl.calls.push(opts);
    const ok = opts.walletAddress ? rl.wallet : rl.ip;
    if (!ok) res.status(429).json({ error: "Too many requests" });
    return ok;
  }),
  checkGlobalLimit: vi.fn(async (res, opts) => {
    rl.calls.push({ ...opts, global: true });
    if (!rl.global) res.status(503).json({ error: "Service temporarily unavailable" });
    return rl.global;
  }),
}));

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl";
const IMG_CID = `bafkrei${"a".repeat(52)}`;
const JSON_CID = `bafkrei${"b".repeat(52)}`;
const PROGRAM = "64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2";

const creatorKey = ed25519.utils.randomPrivateKey();
const CREATOR = base58.encode(ed25519.getPublicKey(creatorKey));
const MINT = base58.encode(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));

function makeReq({ method = "POST", body = null, headers = {}, query = {} } = {}) {
  return { method, body, query, headers: { origin: "https://memetic.fun", ...headers } };
}
function makeRes() {
  const out = { status: null, body: undefined, headers: {} };
  const res = {
    setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; return res; },
    status: (c) => { out.status = c; return res; },
    json: (p) => { out.body = p; return res; },
    send: (p) => { out.body = p; return res; },
    end: () => res,
  };
  return { res, out };
}

/** A fake upstream: Pinata endpoints and the RPC. Records every call. */
function fakeUpstream({ imageDuplicate = false, jsonFails = false, rows = [], refs = {}, curves = {}, rpcFails = false } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (u.endsWith("/pinning/pinFileToIPFS")) return ok({ IpfsHash: IMG_CID, PinSize: 1, Timestamp: "x", isDuplicate: imageDuplicate });
    if (u.endsWith("/pinning/pinJSONToIPFS")) {
      return jsonFails ? new Response("boom", { status: 500 }) : ok({ IpfsHash: JSON_CID, PinSize: 1, Timestamp: "x" });
    }
    if (u.includes("/pinning/unpin/")) return new Response("OK", { status: 200 });
    if (u.includes("/data/pinList")) {
      const kv = JSON.parse(new URL(u).searchParams.get("metadata[keyvalues]"));
      if (kv.image) return ok({ rows: refs[kv.image.value] ?? [] });
      return ok({ rows });
    }
    if (u.startsWith("https://api.mainnet-beta.solana.com") || u.startsWith("http://rpc.test")) {
      if (rpcFails) return new Response("nope", { status: 500 });
      const body = JSON.parse(init.body);
      const value = body.params[0].map((addr) => (curves[addr] === undefined ? null : { owner: curves[addr], lamports: 1, data: ["", "base64"] }));
      return ok({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } });
    }
    return new Response("unexpected", { status: 599 });
  });
  fn.calls = calls;
  return fn;
}

async function signedBody(over = {}, { image = PNG_1X1, mime = "image/png", sign = {}, key = creatorKey } = {}) {
  const fields = {
    name: "Pepe", symbol: "PEPE", description: "a frog", links: { twitter: "https://x.com/pepe" },
    mint: MINT, creator: CREATOR, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    ...over,
  };
  const s = { ...fields, ...sign };
  const message = uploadAuthMessage({
    name: s.name, symbol: s.symbol, mint: s.mint, creator: s.creator, expiresAt: s.expiresAt,
    detailsSha256: await sha256Hex(detailsDigestInput(s)),
    imageSha256: await sha256Hex(sign.image ?? image),
  });
  const signature = base58.encode(ed25519.sign(new TextEncoder().encode(message), key));
  return { ...fields, signature, image: { mime, base64: Buffer.from(image).toString("base64") } };
}

let handler;
let errSpy;
beforeEach(async () => {
  vi.resetModules();
  rl.ip = rl.wallet = rl.global = true;
  rl.calls = [];
  process.env.PINATA_JWT = JWT;
  delete process.env.CRON_SECRET;
  delete process.env.SOLANA_RPC_URL;
  delete process.env.SOLANA_LAUNCH_PROGRAM_ID;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  handler = (await import("../launch-upload.js")).default;
});
afterEach(() => {
  delete process.env.PINATA_JWT;
  delete process.env.CRON_SECRET;
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;
  errSpy.mockRestore();
  vi.unstubAllGlobals();
});

async function post(body, extra = {}) {
  const { res, out } = makeRes();
  await handler(makeReq({ body, ...extra }), res);
  return out;
}

describe("GET: is it configured", () => {
  it("says true only when PINATA_JWT is set, and never echoes it", async () => {
    const { res, out } = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(out).toMatchObject({ status: 200, body: { configured: true } });
    expect(JSON.stringify(out)).not.toContain(JWT);
    delete process.env.PINATA_JWT;
    const again = makeRes();
    await handler(makeReq({ method: "GET" }), again.res);
    expect(again.out.body).toEqual({ configured: false });
  });
});

describe("POST", () => {
  it("is off (503 not-configured) without PINATA_JWT, before touching anything", async () => {
    delete process.env.PINATA_JWT;
    const up = fakeUpstream();
    vi.stubGlobal("fetch", up);
    const out = await post(await signedBody());
    expect(out).toMatchObject({ status: 503, body: { reason: "not-configured" } });
    expect(up).not.toHaveBeenCalled();
  });

  it("refuses a foreign origin in production", async () => {
    process.env.VERCEL_ENV = "production";
    vi.stubGlobal("fetch", fakeUpstream());
    const out = await post(await signedBody(), { headers: { origin: "https://evil.example" } });
    expect(out.status).toBe(403);
  });

  it("pins the picture, then the details file pointing at it, and returns both addresses", async () => {
    const up = fakeUpstream();
    vi.stubGlobal("fetch", up);
    const out = await post(await signedBody());
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      imageUri: `ipfs://${IMG_CID}`,
      metadataUri: `ipfs://${JSON_CID}`,
      metadata: buildMetadataJson({
        name: "Pepe", symbol: "PEPE", description: "a frog", imageUri: `ipfs://${IMG_CID}`,
        links: { twitter: "https://x.com/pepe" }, mint: MINT,
      }),
    });
    const [img, meta] = up.calls;
    expect(img.url).toBe("https://api.pinata.cloud/pinning/pinFileToIPFS");
    expect(img.init.headers.Authorization).toBe(`Bearer ${JWT}`);
    const imgMeta = JSON.parse(img.init.body.get("pinataMetadata"));
    expect(imgMeta.keyvalues).toEqual({ app: "tegridy-launch", mint: MINT, creator: CREATOR, part: "image" });
    const sent = new Uint8Array(await img.init.body.get("file").arrayBuffer());
    expect([...sent]).toEqual([...PNG_1X1]);
    const metaBody = JSON.parse(meta.init.body);
    expect(metaBody.pinataContent).toEqual(out.body.metadata);
    expect(metaBody.pinataMetadata.keyvalues).toMatchObject({ part: "json", mint: MINT, image: IMG_CID });
    expect(JSON.stringify(out.body)).not.toContain(JWT);
  });

  it("applies per-IP, per-wallet and global limits", async () => {
    vi.stubGlobal("fetch", fakeUpstream());
    await post(await signedBody());
    expect(rl.calls.map((c) => c.identifier)).toEqual(["launch-upload", "launch-upload-wallet", "launch-upload"]);
    expect(rl.calls[1].walletAddress).toBe(CREATOR);
    expect(rl.calls[2].global).toBe(true);
    for (const c of rl.calls) expect(c.windowSec).toBe(3600);
  });

  it("does not pin when the wallet limit is spent", async () => {
    const up = fakeUpstream();
    vi.stubGlobal("fetch", up);
    rl.wallet = false;
    expect((await post(await signedBody())).status).toBe(429);
    expect(up).not.toHaveBeenCalled();
  });

  describe("refuses, and pins nothing, when", () => {
    const cases = [
      ["the picture is SVG dressed as PNG", () => signedBody({}, { image: SVG, mime: "image/png" }), 400],
      ["the declared type differs from the bytes", () => signedBody({}, { image: png(10, 10), mime: "image/jpeg" }), 400],
      ["the picture still carries EXIF", () => signedBody({}, { image: jpeg(10, 10, { exif: true }), mime: "image/jpeg" }), 400],
      ["the picture is over 1 MiB", async () => { const b = new Uint8Array(1048577); b.set(PNG_1X1); return signedBody({}, { image: b }); }, 413],
      ["the name hides a direction override", () => signedBody({ name: "Pe\u202Epe" }), 400],
      ["the symbol is reserved", () => signedBody({ symbol: "SOL" }), 400],
      ["a link is not https", () => signedBody({ links: { website: "http://pepe.io" } }), 400],
      ["the mint is not an address", () => signedBody({ mint: "not-a-key" }), 400],
      ["the mint is the creator", () => signedBody({ mint: CREATOR }), 400],
      ["the signature is over a different picture", () => signedBody({}, { sign: { image: png(2, 2) } }), 401],
      ["the name was changed after signing", () => signedBody({}, { sign: { name: "Pepo" } }), 401],
      ["the description was changed after signing", () => signedBody({}, { sign: { description: "b" } }), 401],
      ["the mint was changed after signing", () => signedBody({}, { sign: { mint: CREATOR.slice(0, -1) + "2" } }), 401],
      ["another wallet signed", () => signedBody({}, { key: ed25519.utils.randomPrivateKey() }), 401],
      ["the signed request expired", () => signedBody({ expiresAt: new Date(Date.now() - 1000).toISOString() }), 401],
      ["the expiry is too far ahead", () => signedBody({ expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }), 400],
      ["the expiry is not canonical ISO", () => signedBody({ expiresAt: "2099-01-01" }), 400],
      ["the signature is missing", async () => ({ ...(await signedBody()), signature: "" }), 401],
    ];
    for (const [label, make, status] of cases) {
      it(label, async () => {
        const up = fakeUpstream();
        vi.stubGlobal("fetch", up);
        const out = await post(await make());
        expect(out.status).toBe(status);
        expect(typeof out.body.error).toBe("string");
        expect(up).not.toHaveBeenCalled();
      });
    }

    it("the body is declared larger than 2 MiB", async () => {
      const up = fakeUpstream();
      vi.stubGlobal("fetch", up);
      const out = await post(await signedBody(), { headers: { "content-length": String(3 * 1024 * 1024) } });
      expect(out.status).toBe(413);
      expect(up).not.toHaveBeenCalled();
    });

    it("the image is not strict base64", async () => {
      const up = fakeUpstream();
      vi.stubGlobal("fetch", up);
      const body = await signedBody();
      body.image.base64 = body.image.base64.slice(0, -2) + "!!";
      expect((await post(body)).status).toBe(400);
      expect(up).not.toHaveBeenCalled();
    });
  });

  it("removes the picture again when the details file cannot be pinned", async () => {
    const up = fakeUpstream({ jsonFails: true });
    vi.stubGlobal("fetch", up);
    const out = await post(await signedBody());
    expect(out.status).toBe(502);
    expect(up.calls.map((c) => c.url)).toContain(`https://api.pinata.cloud/pinning/unpin/${IMG_CID}`);
    expect(errSpy.mock.calls.flat().join(" ")).not.toContain(JWT);
  });

  it("leaves a duplicate picture alone (it belongs to an earlier upload)", async () => {
    const up = fakeUpstream({ jsonFails: true, imageDuplicate: true });
    vi.stubGlobal("fetch", up);
    await post(await signedBody());
    expect(up.calls.some((c) => c.url.includes("/unpin/"))).toBe(false);
  });
});

describe("the browser client against this handler", () => {
  it("round-trips: what upload.ts signs is what the server verifies", async () => {
    vi.stubGlobal("fetch", fakeUpstream());
    const { uploadLaunchMetadata } = await import("../../src/lib/launchMetadata/upload.ts");
    const bridge = async (url, init) => {
      const { res, out } = makeRes();
      await handler(makeReq({ method: init.method, body: JSON.parse(init.body) }), res);
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
    };
    const r = await uploadLaunchMetadata({
      image: { bytes: PNG_1X1, mime: "image/png", width: 1, height: 1 },
      name: " Pepe ", symbol: "pepe", description: "a frog\r\n", links: { twitter: "@pepe" },
      mint: MINT, creator: CREATOR,
      signMessage: async (m) => ed25519.sign(m, creatorKey),
    }, bridge);
    expect(r).toMatchObject({ ok: true, imageUri: `ipfs://${IMG_CID}`, metadataUri: `ipfs://${JSON_CID}` });
    expect(r.metadata).toMatchObject({ name: "Pepe", symbol: "PEPE", description: "a frog", twitter: "https://x.com/pepe", mint: MINT });
  });
});

describe("the orphan sweep", () => {
  const T = Date.now();
  const iso = (msAgo) => new Date(T - msAgo).toISOString();
  const cid = (c) => `bafkrei${c.repeat(52)}`;
  const row = (c, mint, part, msAgo, extra = {}) => ({
    ipfs_pin_hash: cid(c), date_pinned: iso(msAgo),
    metadata: { name: "x", keyvalues: { app: "tegridy-launch", mint, creator: CREATOR, part, ...extra } },
  });
  const orphan = base58.encode(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
  const launched = base58.encode(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
  const curveOf = (m) => PublicKey.findProgramAddressSync([Buffer.from("curve"), new PublicKey(m).toBuffer()], new PublicKey(PROGRAM))[0].toBase58();

  async function sweep(up, auth = "Bearer s3cret") {
    vi.stubGlobal("fetch", up);
    const { res, out } = makeRes();
    await handler(makeReq({ method: "GET", query: { sweep: "1" }, headers: { authorization: auth, origin: undefined } }), res);
    return out;
  }

  it("is refused without CRON_SECRET, and with the wrong one", async () => {
    const up = fakeUpstream();
    expect((await sweep(up)).status).toBe(503);
    process.env.CRON_SECRET = "s3cret";
    expect((await sweep(up, "Bearer wrong!")).status).toBe(401);
    expect(up).not.toHaveBeenCalled();
  });

  it("derives the same curve address as @solana/web3.js", async () => {
    const { curveAddress } = await import("../_lib/launch-pins.js");
    for (const m of [orphan, launched, MINT]) expect(curveAddress(m, PROGRAM)).toBe(curveOf(m));
  });

  it("unpins a mint with no launch, keeps a launched one, and keeps a picture a launched mint shares", async () => {
    process.env.CRON_SECRET = "s3cret";
    const up = fakeUpstream({
      rows: [
        row("c", orphan, "json", 60 * 60 * 1000, { image: cid("d") }),
        row("d", orphan, "image", 60 * 60 * 1000),
        row("e", launched, "json", 60 * 60 * 1000, { image: cid("f") }),
        row("f", launched, "image", 60 * 60 * 1000),
        row("g", orphan, "image", 60 * 60 * 1000), // shared with the launched mint below
      ],
      refs: {
        [cid("d")]: [row("c", orphan, "json", 60 * 60 * 1000, { image: cid("d") })],
        [cid("g")]: [row("h", launched, "json", 50 * 60 * 1000, { image: cid("g") })],
      },
      curves: { [curveOf(launched)]: PROGRAM },
    });
    const out = await sweep(up);
    expect(out.status).toBe(200);
    const unpinned = up.calls.filter((c) => c.url.includes("/unpin/")).map((c) => c.url.split("/").pop()).sort();
    expect(unpinned).toEqual([cid("c"), cid("d")]);
    expect(out.body).toMatchObject({ ok: true, unpinned: 2 });
    // it only asked Pinata for pins 30 min to 6 h old
    const list = new URL(up.calls.find((c) => c.url.includes("/data/pinList")).url);
    expect(Date.parse(list.searchParams.get("pinEnd"))).toBeLessThanOrEqual(Date.now() - 30 * 60 * 1000);
    expect(JSON.parse(list.searchParams.get("metadata[keyvalues]"))).toEqual({ app: { value: "tegridy-launch", op: "eq" } });
  });

  it("treats a curve address that holds SOL but is not owned by the program as no launch", async () => {
    process.env.CRON_SECRET = "s3cret";
    const up = fakeUpstream({
      rows: [row("c", orphan, "json", 60 * 60 * 1000)],
      curves: { [curveOf(orphan)]: "11111111111111111111111111111111" },
    });
    await sweep(up);
    expect(up.calls.filter((c) => c.url.includes("/unpin/"))).toHaveLength(1);
  });

  it("keeps everything when the chain cannot be read (unreadable is not 'no launch')", async () => {
    process.env.CRON_SECRET = "s3cret";
    const up = fakeUpstream({ rows: [row("c", orphan, "json", 60 * 60 * 1000), row("d", orphan, "image", 60 * 60 * 1000)], rpcFails: true });
    const out = await sweep(up);
    expect(up.calls.some((c) => c.url.includes("/unpin/"))).toBe(false);
    expect(out.body).toMatchObject({ unreadable: 2, unpinned: 0 });
  });

  it("keeps a picture whose newest details file is still young", async () => {
    process.env.CRON_SECRET = "s3cret";
    const second = base58.encode(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
    const up = fakeUpstream({
      rows: [row("d", orphan, "image", 60 * 60 * 1000)],
      refs: { [cid("d")]: [row("c", orphan, "json", 60 * 60 * 1000), row("h", second, "json", 60 * 1000)] },
    });
    await sweep(up);
    expect(up.calls.some((c) => c.url.includes("/unpin/"))).toBe(false);
  });

  it("ignores pins that are not ours", async () => {
    process.env.CRON_SECRET = "s3cret";
    const foreign = row("c", orphan, "json", 60 * 60 * 1000);
    foreign.metadata.keyvalues.app = "something-else";
    const up = fakeUpstream({ rows: [foreign] });
    await sweep(up);
    expect(up.calls.some((c) => c.url.includes("/unpin/"))).toBe(false);
  });
});
