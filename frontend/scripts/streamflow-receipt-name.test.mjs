// @vitest-environment node
// Node, not jsdom: PublicKey.findProgramAddressSync fails every bump under jsdom.
//
// Pins for the receipt-naming script. None of these can fail locally by running it: a
// wrong discriminator, a reordered account or a shifted offset only shows on chain. So
// they are held to the IDL that ships in @streamflow/staking, and each refusal is driven,
// first as a pure function and then through the whole run against a made-up node and site.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { MINT_TOKENS, SITE, metadataFor, metadataUri, pictureFile, serialize } from './lib/mint-identity.mjs';
import {
  SET_TOKEN_METADATA_T22, STAKE_POOL_DISCRIMINATOR, STAKE_POOL_OFFSETS, STAKE_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID, broadcastProblems, decodeStakePool, decodeTokenMetadata,
  encodeSetTokenMetadata, linkProblems, outcomeLine, rpcErrorKind, run, sameMetadata,
  setTokenMetadataIx, stakeMintFor, targetFor, writeProblems,
} from './streamflow-receipt-name.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const idl = JSON.parse(readFileSync(
  join(HERE, '..', 'node_modules', '@streamflow', 'staking', 'dist', 'esm', 'solana', 'descriptor', 'idl', 'stake_pool.json'),
  'utf8',
));
const idlIx = idl.instructions.find((i) => i.name === 'set_token_metadata_t22');

const receipt = MINT_TOKENS.find((t) => t.kind === 'staking-receipt');
const target = targetFor(receipt);
const stakePool = new PublicKey(receipt.stakePool);
const authority = new PublicKey('Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6');
const stranger = new PublicKey('GCCSLE7dBPMijj5F4pDxe592mcGAK83N84R2w5HPauV9');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const text = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
// A Token-2022 mint as bytes: 166 of base and padding, then extensions as (type, length, body).
const extension = (type, body) => { const head = Buffer.alloc(4); head.writeUInt16LE(type, 0); head.writeUInt16LE(body.length, 2); return Buffer.concat([head, body]); };
const pointer = extension(18, Buffer.alloc(64));
const metadata = (m) => extension(19, Buffer.concat([stakePool.toBuffer(), Buffer.alloc(32), text(m.name), text(m.symbol), text(m.uri), u32(0)]));
const mint = (...extensions) => Buffer.concat([Buffer.alloc(166), ...extensions]);

describe('the instruction, held to the IDL in @streamflow/staking', () => {
  it('finds the instruction and the program in the IDL at all', () => {
    expect(idlIx).toBeDefined();
    expect(STAKE_PROGRAM_ID.toBase58()).toBe(idl.address);
  });

  it('opens with the discriminator ef865b53c439786a', () => {
    expect(SET_TOKEN_METADATA_T22.toString('hex')).toBe('ef865b53c439786a');
    expect([...SET_TOKEN_METADATA_T22]).toEqual(idlIx.discriminator);
  });

  it('carries name, symbol and link as three length-prefixed strings, in the IDL order', () => {
    expect(idlIx.args).toEqual([
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'uri', type: 'string' },
    ]);
    const data = encodeSetTokenMetadata(target);
    expect(data.equals(Buffer.concat([Buffer.from(idlIx.discriminator), text(target.name), text(target.symbol), text(target.uri)]))).toBe(true);
    // Read back in the IDL's argument order, to the last byte.
    let at = 8;
    const decoded = idlIx.args.map(() => {
      const n = data.readUInt32LE(at);
      at += 4 + n;
      return data.subarray(at - n, at).toString('utf8');
    });
    expect(decoded).toEqual([receipt.name, receipt.symbol, metadataUri(receipt.mint)]);
    expect(at).toBe(data.length);
  });

  it('writes the words of the one list: Staked BAYLA, sBAYLA, the link on the canonical host', () => {
    expect(target).toEqual({ name: 'Staked BAYLA', symbol: 'sBAYLA', uri: `${SITE}/mint/${receipt.mint}.json` });
  });

  it('passes five accounts in the IDL order, with the IDL flags', () => {
    const stakeMint = stakeMintFor(stakePool);
    const ix = setTokenMetadataIx({ authority, stakePool, stakeMint, target });
    expect(ix.programId.equals(STAKE_PROGRAM_ID)).toBe(true);
    expect(idlIx.accounts.map((a) => a.name)).toEqual(['authority', 'stake_pool', 'stake_mint', 'token_program', 'system_program']);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      authority.toBase58(),
      stakePool.toBase58(),
      stakeMint.toBase58(),
      idlIx.accounts[3].address,
      idlIx.accounts[4].address,
    ]);
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual(
      idlIx.accounts.map((a) => [a.signer === true, a.writable === true]),
    );
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([authority.toBase58()]);
    expect(TOKEN_2022_PROGRAM_ID.toBase58()).toBe(idlIx.accounts[3].address);
    expect(SystemProgram.programId.toBase58()).toBe(idlIx.accounts[4].address);
  });

  it('derives the receipt mint in the list from its stake pool', () => {
    expect(stakeMintFor(stakePool).toBase58()).toBe(receipt.mint);
  });
});

describe('reading the stake pool account', () => {
  const SIZES = { u8: 1, bool: 1, u64: 8, u128: 16, pubkey: 32 };
  const fields = idl.types.find((t) => t.name === 'StakePool').type.fields;
  const offsetOf = (name) => {
    let at = 8;
    for (const f of fields) {
      if (f.name === name) return at;
      at += SIZES[f.type];
    }
    throw new Error(`no field ${name}`);
  };

  it('reads each field at the offset the IDL gives it', () => {
    expect([...STAKE_POOL_DISCRIMINATOR]).toEqual(idl.accounts.find((a) => a.name === 'StakePool').discriminator);
    expect(STAKE_POOL_OFFSETS).toEqual({
      mint: offsetOf('mint'),
      creator: offsetOf('creator'),
      authority: offsetOf('authority'),
      stakeMint: offsetOf('stake_mint'),
    });
  });

  it('decodes an account laid out that way, and refuses anything else', () => {
    const data = Buffer.alloc(296);
    STAKE_POOL_DISCRIMINATOR.copy(data, 0);
    authority.toBuffer().copy(data, offsetOf('authority'));
    stranger.toBuffer().copy(data, offsetOf('creator'));
    stakeMintFor(stakePool).toBuffer().copy(data, offsetOf('stake_mint'));
    const pool = decodeStakePool(data);
    expect(pool.authority.equals(authority)).toBe(true);
    expect(pool.creator.equals(stranger)).toBe(true);
    expect(pool.stakeMint.toBase58()).toBe(receipt.mint);

    const other = Buffer.from(data);
    other[0] ^= 0xff;
    expect(() => decodeStakePool(other)).toThrow(/not a Streamflow StakePool/);
    expect(() => decodeStakePool(data.subarray(0, 100))).toThrow(/too short/);
  });
});

describe('reading the name a Token-2022 mint holds', () => {
  it('says none for a mint with only the pointer, as the receipt is today', () => {
    expect(decodeTokenMetadata(mint(pointer))).toBeNull();
    expect(mint(pointer)).toHaveLength(234);
  });

  it('reads name, symbol, link and who can edit them', () => {
    const read = decodeTokenMetadata(mint(pointer, metadata(target)));
    expect({ name: read.name, symbol: read.symbol, uri: read.uri }).toEqual(target);
    expect(read.updateAuthority.equals(stakePool)).toBe(true);
    expect(sameMetadata(read, target)).toBe(true);
    expect(sameMetadata(decodeTokenMetadata(mint(pointer, metadata({ ...target, uri: `${target.uri}x` }))), target)).toBe(false);
    expect(sameMetadata(null, target)).toBe(false);
  });
});

describe('the files must be live before anything is written on chain', () => {
  // A stand-in picture: what matters is that its name carries the hash of these bytes.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const picture = pictureFile(receipt.picture, sha256(png));
  const committed = serialize(metadataFor(receipt, picture));
  const body = JSON.parse(committed);
  const image = { status: 200, contentType: 'image/png', firstBytes: '89504e470d0a1a0a', sha256: sha256(png) };
  const file = (over = {}) => ({ status: 200, contentType: 'application/json; charset=utf-8', text: committed, ...over });
  const check = (f, i = image, c = committed) => linkProblems({ token: receipt, file: f, image: i, committed: c });
  // An earlier deploy that is whole in itself: its own picture, under that picture's hash.
  const olderPng = Buffer.concat([png, Buffer.from('older')]);
  const older = serialize(metadataFor(receipt, pictureFile(receipt.picture, sha256(olderPng))));

  it('passes the file and picture the generator writes, served as this checkout holds them', () => {
    expect(check(file())).toEqual([]);
  });

  it('refuses the app page answering 200, which is what a missing file is on this host', () => {
    const problems = check({ status: 200, contentType: 'text/html; charset=utf-8', text: '<!doctype html><html><head></head></html>' }, null);
    expect(problems.join(' ')).toMatch(/not JSON/);
    expect(problems.length).toBeGreaterThan(0);
  });

  it.each([
    ['a redirect', file({ status: 308 }), image, /HTTP 308/],
    ['an unread link', { error: 'timed out' }, image, /could not be read/],
    ['JSON served as text', file({ contentType: 'text/plain' }), image, /not JSON/],
    ['the default file answering for this mint', file({ text: JSON.stringify({ ...body, name: 'Memetics Pool Share', symbol: 'MEM-LP' }) }), image, /name is "Memetics Pool Share"/],
    ['another symbol', file({ text: JSON.stringify({ ...body, symbol: 'BAYLA' }) }), image, /symbol is "BAYLA"/],
    ['a picture on another host', file({ text: JSON.stringify({ ...body, image: 'https://example.com/a.png' }) }), image, /picture is not on/],
    ['a picture that was never fetched', file(), null, /was not fetched/],
    ['a missing picture', file(), { ...image, status: 404 }, /picture answered HTTP 404/],
    ['the app page where the picture should be', file(), { status: 200, contentType: 'text/html; charset=utf-8', firstBytes: '3c21646f63747970', sha256: sha256(Buffer.from('<!doctype')) }, /not a PNG/],
    ['an unread picture', file(), { error: 'request failed' }, /picture could not be read/],
    ['an earlier copy: the same name and symbol, other words', file({ text: serialize({ ...body, description: 'An earlier sentence.' }) }), image, /not byte for byte what the list writes/],
    ['a fifth field', file({ text: serialize({ ...body, extra: 'x' }) }), image, /not byte for byte what the list writes/],
    ['a picture whose bytes are not the ones its name promises', file(), { ...image, sha256: 'f'.repeat(64) }, /do not carry the hash in its name/],
  ])('refuses %s', (_name, f, i, reason) => {
    const problems = check(f, i);
    expect(problems.join(' | ')).toMatch(reason);
  });

  it('refuses an earlier deploy that only this checkout can tell from the new one', () => {
    // Its words are the list's and its picture carries its own hash. Only the picture is old.
    const olderImage = { ...image, sha256: sha256(olderPng) };
    const problems = check(file({ text: older }), olderImage);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/does not answer this checkout's public\/mint\/.*byte for byte/);
    expect(check(file({ text: older }), olderImage, older)).toEqual([]);
  });

  it('refuses when this checkout has no file to compare the link with', () => {
    expect(check(file(), image, null).join(' | ')).toMatch(/could not be read, so the link has nothing to be compared with/);
  });
});

describe('a broadcast is refused unless every condition holds', () => {
  const ok = { linkProblems: [], signer: authority, authority, feePayer: authority, simulationError: null, current: null, target };

  it('allows it when all of them hold', () => {
    expect(broadcastProblems(ok)).toEqual([]);
    expect(writeProblems(ok)).toEqual([]);
  });

  it.each([
    ['the files are not live', { linkProblems: ['the link answered HTTP 404, not 200'] }, /files are not live: the link answered HTTP 404/],
    ['the key is not the pool authority', { signer: stranger, feePayer: stranger }, /the pool's authority is Fu7mNAv6/],
    ['someone else pays the fee', { feePayer: stranger }, /fee payer is not the signing key/],
    ['the simulation did not pass', { simulationError: '{"InstructionError":[0,{"Custom":6005}]}' }, /simulation did not pass/],
    ['the chain already says it', { current: { ...target } }, /already holds this name/],
  ])('refuses when %s', (_name, change, reason) => {
    const problems = broadcastProblems({ ...ok, ...change });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(reason);
  });

  it('knows three of those reasons before any key is opened', () => {
    expect(writeProblems({ ...ok, linkProblems: ['x'] })).toHaveLength(1);
    expect(writeProblems({ ...ok, simulationError: '{}' })).toHaveLength(1);
    expect(writeProblems({ ...ok, current: { ...target } })).toHaveLength(1);
  });

  it('still allows a correction: the chain holds a different name', () => {
    expect(broadcastProblems({ ...ok, current: { ...target, name: 'Staked' } })).toEqual([]);
  });
});

describe('what a node error means', () => {
  const refusal = {
    code: -32002,
    message: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1775',
    data: { err: { InstructionError: [0, { Custom: 6005 }] }, logs: ['Program log: AnchorError occurred. Error Code: Unauthorized. Error Number: 6005.', 'Program STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH consumed 17429 of 200000 compute units'] },
  };

  it('calls a rate limit a rate limit, by its code or its message', () => {
    expect(rpcErrorKind({ code: 429, message: 'slow down' })).toBe('rate-limited');
    expect(rpcErrorKind({ code: -32005, message: 'Too many requests for a specific RPC call' })).toBe('rate-limited');
    expect(rpcErrorKind({ code: -32000, message: 'HTTP 429: rate limit exceeded' })).toBe('rate-limited');
  });

  it('never reads a rate limit out of the logs: 17429 compute units is not a 429', () => {
    expect(JSON.stringify(refusal)).toMatch(/429/);
    expect(rpcErrorKind(refusal)).toBe('refused');
    expect(rpcErrorKind({ code: -32002, message: 'custom program error: 0x1429' })).toBe('refused');
  });

  it('knows a node that has already seen these bytes from one that refused them', () => {
    expect(rpcErrorKind({ code: -32002, message: 'Transaction simulation failed: This transaction has already been processed', data: { err: 'AlreadyProcessed' } })).toBe('already-processed');
    expect(rpcErrorKind({ code: -32002, message: 'Transaction simulation failed', data: { err: 'AlreadyProcessed' } })).toBe('already-processed');
    expect(rpcErrorKind({ code: -32002, message: 'Transaction simulation failed: Blockhash not found', data: { err: 'BlockhashNotFound' } })).toBe('refused');
  });
});

describe('what is said after a send', () => {
  const SIG = '5'.repeat(88);

  it('calls an unread confirmation sent and not confirmed, with the signature, never a failure', () => {
    const line = outcomeLine(SIG, null);
    expect(line.startsWith('sent, not confirmed.')).toBe(true);
    expect(line).toContain(SIG);
    expect(line).not.toMatch(/fail/i);
  });

  it('does not say sent when the answer to the send itself was lost', () => {
    const line = outcomeLine(SIG, null, true);
    expect(line.startsWith('not confirmed.')).toBe(true);
    expect(line).toMatch(/not known whether the transaction went out/);
    expect(line).toContain(SIG);
    expect(line).not.toMatch(/fail|NOT SENT/i);
  });

  it('says confirmed only on a confirmed status, and reverted only on a read error', () => {
    expect(outcomeLine(SIG, { confirmed: true })).toBe(`confirmed. signature ${SIG}`);
    expect(outcomeLine(SIG, { confirmed: true }, true)).toBe(`confirmed. signature ${SIG}`);
    const reverted = outcomeLine(SIG, { reverted: { InstructionError: [0, { Custom: 6005 }] } });
    expect(reverted).toMatch(/^landed and reverted on chain/);
    expect(reverted).toContain(SIG);
  });
});

// The real run(), start to finish. Nothing leaves this process: the node and the site
// are made up below, any other address is recorded and refused, and the signing key is a
// throwaway made here that never touches a disk.
describe('the whole run, against a node and a site that exist only in this test', () => {
  const key = Keypair.generate();
  const KEY_FILE = join(HERE, 'no-such-folder', 'throwaway-id.json');
  const RPC_SECRETS = ['rpcuser', 'rpcpass', 'PATHSECRET0123456789abcdef', 'QUERYSECRET9876543210'];
  const RPC_URL = `http://${RPC_SECRETS[0]}:${RPC_SECRETS[1]}@mock.invalid/v2/${RPC_SECRETS[2]}?api-key=${RPC_SECRETS[3]}`;
  const T22 = TOKEN_2022_PROGRAM_ID.toBase58();
  const stakeMint = stakeMintFor(stakePool);
  const PUBLIC = join(HERE, '..', 'public');
  const committed = readFileSync(join(PUBLIC, 'mint', `${receipt.mint}.json`), 'utf8');
  const picturePath = new URL(JSON.parse(committed).image).pathname;
  const pictureBytes = readFileSync(join(PUBLIC, picturePath));
  const olderBytes = Buffer.concat([pictureBytes, Buffer.from('older')]);
  const olderName = pictureFile(receipt.picture, sha256(olderBytes));

  const ctx = { slot: 123 };
  const answer = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  const rpcError = (error) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error }), { status: 200, headers: { 'content-type': 'application/json' } });
  const http = (status) => new Response('', { status });
  const served = (body, type) => new Response(body, { status: 200, headers: { 'content-type': type } });
  const ALREADY = { code: -32002, message: 'Transaction simulation failed: This transaction has already been processed', data: { err: 'AlreadyProcessed', logs: [], unitsConsumed: 0 } };
  const UNAUTHORIZED = {
    code: -32002,
    message: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1775',
    data: { err: { InstructionError: [0, { Custom: 6005 }] }, logs: ['Program log: AnchorError occurred. Error Code: Unauthorized. Error Number: 6005.', 'Program STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH consumed 17429 of 200000 compute units'] },
  };

  /** A made-up chain and site. `over` changes one thing about them. */
  function world(over = {}) {
    const w = {
      authority: key.publicKey, // who the pool says may name the receipt
      named: false, // does the mint already hold the target?
      simErr: null,
      site: 'live', // or 'app-page', 'older-words', 'older-picture'
      send: () => answer('the node took it'), // (n) => the answer to the n-th send
      status: { slot: 124, confirmations: 3, err: null, confirmationStatus: 'confirmed' }, // null: never seen
      flaky: false, // every read is refused once with HTTP 429 first
      dead: false, // the node answers nothing but 503
      ...over,
    };
    const calls = {};
    const sent = [];
    const outside = [];
    const opened = [];
    const lines = [];
    const refusedOnce = new Set();
    let height = 900;

    const pool = Buffer.alloc(296);
    STAKE_POOL_DISCRIMINATOR.copy(pool, 0);
    new PublicKey('7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump').toBuffer().copy(pool, STAKE_POOL_OFFSETS.mint);
    stranger.toBuffer().copy(pool, STAKE_POOL_OFFSETS.creator);
    w.authority.toBuffer().copy(pool, STAKE_POOL_OFFSETS.authority);
    stakeMint.toBuffer().copy(pool, STAKE_POOL_OFFSETS.stakeMint);
    const bare = mint(pointer);
    const withName = mint(pointer, metadata(target));
    const account = (owner, data, lamports) => ({ lamports, owner, executable: false, data: [data.toString('base64'), 'base64'] });

    function node(method, params) {
      calls[method] = (calls[method] ?? 0) + 1;
      if (w.dead) return http(503);
      if (w.flaky && method !== 'sendTransaction' && !refusedOnce.has(method)) {
        refusedOnce.add(method);
        return http(429);
      }
      switch (method) {
        case 'getGenesisHash': return answer('MadeUpGenesis11111111111111111111111111111111');
        case 'getMultipleAccounts': return answer({ context: ctx, value: [account(STAKE_PROGRAM_ID.toBase58(), pool, 2_951_040), account(T22, w.named ? withName : bare, 2_519_520)] });
        case 'getAccountInfo': return answer({ context: ctx, value: account(SystemProgram.programId.toBase58(), Buffer.alloc(0), 1_000_000_000) });
        case 'simulateTransaction': return answer({ context: ctx, value: { err: w.simErr, logs: ['Program log: Instruction: SetTokenMetadataT22'], unitsConsumed: 17_993, accounts: [account(T22, withName, 2_753_360)] } });
        case 'getLatestBlockhash': return answer({ context: ctx, value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 } });
        case 'getFeeForMessage': return answer({ context: ctx, value: 5000 });
        // Two polls and the blockhash has expired.
        case 'getBlockHeight': height += 60; return answer(height);
        case 'sendTransaction': sent.push(params[0]); return w.send(calls.sendTransaction);
        case 'getSignatureStatuses': return answer({ context: ctx, value: [w.status] });
        default: return rpcError({ code: -32601, message: `the made-up node has no ${method}` });
      }
    }

    function site(path) {
      if (w.site === 'app-page') return served('<!doctype html><html><head></head><body><div id="root"></div></body></html>', 'text/html; charset=utf-8');
      const json = 'application/json; charset=utf-8';
      if (path === `/mint/${receipt.mint}.json`) {
        if (w.site === 'older-words') return served(serialize({ ...JSON.parse(committed), description: 'An earlier sentence.' }), json);
        if (w.site === 'older-picture') return served(serialize(metadataFor(receipt, olderName)), json);
        return served(committed, json);
      }
      if (path === picturePath) return served(pictureBytes, 'image/png');
      if (path === `/mint/img/${olderName}` && w.site === 'older-picture') return served(olderBytes, 'image/png');
      // What production answers for any other path under /mint/.
      return served(readFileSync(join(PUBLIC, 'mint', 'default.json'), 'utf8'), json);
    }

    const io = {
      fetch: async (url, init = {}) => {
        const address = String(url);
        if (address === RPC_URL) {
          const { method, params } = JSON.parse(init.body);
          return node(method, params);
        }
        if (address.startsWith(`${SITE}/`)) return site(new URL(address).pathname);
        outside.push(address);
        throw new Error('refused by the test: no real network');
      },
      sleep: async () => {},
      readFile: (path) => {
        if (path !== KEY_FILE) return readFileSync(path, 'utf8');
        opened.push(path);
        return JSON.stringify([...key.secretKey]);
      },
      print: (line) => lines.push(String(line)),
      env: {},
    };
    return { io, calls, sent, outside, opened, lines, out: () => lines.join('\n'), sends: () => calls.sendTransaction ?? 0 };
  }

  const dry = ['--rpc', RPC_URL];
  const live = [...dry, '--broadcast', '--keypair', KEY_FILE];

  it('a dry run says what it would write, sends nothing and opens no key file', async () => {
    const w = world();
    expect(await run(dry, w.io)).toBe(0);
    expect(w.lines[0]).toMatch(/^DRY RUN/);
    expect(w.out()).toMatch(/would write {5}name "Staked BAYLA", symbol "sBAYLA", link https:\/\/memetics\.finance\/mint\//);
    expect(w.out()).toMatch(/files {11}live: /);
    expect(w.sends()).toBe(0);
    expect(w.opened).toEqual([]);
    expect(w.outside).toEqual([]);
  });

  it.each([
    ['the app page answers where the file should be', { site: 'app-page' }, /files are not live: the link is served as "text\/html/],
    ['an earlier copy of the file is live', { site: 'older-words' }, /files are not live: the file is not byte for byte what the list writes/],
    ['an earlier picture is live', { site: 'older-picture' }, /files are not live: the link does not answer this checkout's/],
    ['the simulation did not pass', { simErr: { InstructionError: [0, { Custom: 6005 }] } }, /the simulation did not pass: \{"InstructionError"/],
    ['the chain already holds the name', { named: true }, /the chain already holds this name/],
  ])('refuses a broadcast when %s, and the key file stays closed', async (_name, over, reason) => {
    const w = world(over);
    expect(await run(live, w.io)).toBe(1);
    expect(w.out()).toMatch(/\nREFUSED\. Nothing was signed or sent:/);
    expect(w.out()).toMatch(reason);
    expect(w.sends()).toBe(0);
    expect(w.opened).toEqual([]);
    expect(w.outside).toEqual([]);
  });

  it('refuses a broadcast when the key is not the pool authority', async () => {
    const w = world({ authority: stranger });
    expect(await run(live, w.io)).toBe(1);
    expect(w.out()).toMatch(/\nREFUSED\. Nothing was signed or sent:/);
    expect(w.out()).toContain(`the key is ${key.publicKey.toBase58()}, and the pool's authority is ${stranger.toBase58()}`);
    expect(w.sends()).toBe(0);
    expect(w.opened).toEqual([KEY_FILE]);
  });

  it('sends one transaction, paid by the authority, and says confirmed when every condition holds', async () => {
    const w = world();
    expect(await run(live, w.io)).toBe(0);
    expect(w.sends()).toBe(1);
    expect(w.lines.at(-1)).toMatch(/^\nconfirmed\. signature [1-9A-HJ-NP-Za-km-z]{64,90}$/);
    const tx = Transaction.from(Buffer.from(w.sent[0], 'base64'));
    expect(tx.feePayer.equals(key.publicKey)).toBe(true);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.instructions).toHaveLength(1);
    expect(tx.instructions[0].programId.equals(STAKE_PROGRAM_ID)).toBe(true);
    expect(tx.instructions[0].data.equals(encodeSetTokenMetadata(target))).toBe(true);
    expect(tx.instructions[0].keys.map((k) => k.pubkey.toBase58())).toEqual(
      [key.publicKey, stakePool, stakeMint, TOKEN_2022_PROGRAM_ID, SystemProgram.programId].map((k) => k.toBase58()),
    );
    expect(w.outside).toEqual([]);
  });

  it('prints no part of a keyed endpoint, the key file or its path', async () => {
    const w = world();
    await run(live, w.io);
    expect(w.out()).toContain('mock.invalid');
    for (const secret of [...RPC_SECRETS, KEY_FILE, 'throwaway-id', JSON.stringify([...key.secretKey]).slice(1, 40)]) {
      expect(w.out()).not.toContain(secret);
    }
    const unreadable = world({ dead: true });
    await expect(run(live, unreadable.io)).rejects.toThrow(/^UNREAD getMultipleAccounts: HTTP 503$/);
    for (const secret of RPC_SECRETS) expect(unreadable.out()).not.toContain(secret);
  });

  it('asks again when a read is refused once, and never guesses when none answers', async () => {
    const w = world({ flaky: true });
    expect(await run(live, w.io)).toBe(0);
    expect(w.calls.getMultipleAccounts).toBe(2);
    expect(w.sends()).toBe(1);
    const dead = world({ dead: true });
    await expect(run(dry, dead.io)).rejects.toThrow(/UNREAD/);
    expect(dead.lines.some((l) => /^cluster\s+UNREAD$/.test(l))).toBe(true);
  });

  it('a lost answer to the send is never called NOT SENT: one send, then what the chain says', async () => {
    // The node took the transaction and its answer was lost. A second send of the same
    // bytes would be answered "already processed", which is not a refusal.
    const w = world({ send: (n) => (n === 1 ? http(503) : rpcError(ALREADY)) });
    expect(await run(live, w.io)).toBe(0);
    expect(w.sends()).toBe(1);
    expect(w.out()).not.toMatch(/NOT SENT/);
    expect(w.lines.at(-1)).toMatch(/^\nconfirmed\. signature /);
  });

  it('a node that says it has the transaction already is asked what became of it', async () => {
    const w = world({ send: () => rpcError(ALREADY) });
    expect(await run(live, w.io)).toBe(0);
    expect(w.out()).not.toMatch(/NOT SENT/);
    expect(w.lines.at(-1)).toMatch(/^\nconfirmed\. signature /);
  });

  it.each([
    ['a 503', () => http(503)],
    ['a 429', () => http(429)],
    ['a rate limit in the body', () => rpcError({ code: 429, message: 'Too many requests' })],
  ])('after %s on the send and nothing on chain, it says not confirmed, never sent and never a failure', async (_name, send) => {
    const w = world({ send, status: null });
    expect(await run(live, w.io)).toBe(1);
    expect(w.sends()).toBe(1);
    expect(w.lines.at(-1)).toMatch(/^\nnot confirmed\. signature [1-9A-HJ-NP-Za-km-z]{64,90}\. The node's answer to the send was not read/);
    expect(w.out()).not.toContain('NOT SENT');
    expect(w.lines.at(-1).replace(/signature \S+/, '')).not.toMatch(/fail/i);
    expect(w.calls.getSignatureStatuses).toBeGreaterThan(0);
  });

  it('a sent transaction that is never seen is sent, not confirmed', async () => {
    const w = world({ status: null });
    expect(await run(live, w.io)).toBe(1);
    expect(w.lines.at(-1)).toMatch(/^\nsent, not confirmed\. signature /);
  });

  it('a transaction that landed and reverted is said to have reverted', async () => {
    const w = world({ status: { slot: 124, confirmations: 3, err: { InstructionError: [0, { Custom: 6005 }] }, confirmationStatus: 'confirmed' } });
    expect(await run(live, w.io)).toBe(1);
    expect(w.lines.at(-1)).toMatch(/^\nlanded and reverted on chain/);
  });

  it('a real refusal is NOT SENT, once, even with the digits 429 in its logs', async () => {
    const w = world({ send: () => rpcError(UNAUTHORIZED), status: null });
    expect(await run(live, w.io)).toBe(1);
    expect(w.sends()).toBe(1);
    expect(w.lines.at(-1)).toMatch(/^\nNOT SENT\. The node refused the transaction before sending it: sendTransaction was refused: /);
    // Nothing was sent, so nobody is told to go and look for it.
    expect(w.calls.getSignatureStatuses ?? 0).toBe(0);
  });
});
