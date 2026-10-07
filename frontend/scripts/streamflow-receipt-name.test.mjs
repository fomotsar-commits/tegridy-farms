// @vitest-environment node
// Node, not jsdom: PublicKey.findProgramAddressSync fails every bump under jsdom.
//
// Pins for the receipt-naming script. None of these can fail locally by running it: a
// wrong discriminator, a reordered account or a shifted offset only shows on chain. So
// they are held to the IDL that ships in @streamflow/staking, and each refusal is driven.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { MINT_TOKENS, SITE, metadataUri } from './lib/mint-identity.mjs';
import {
  SET_TOKEN_METADATA_T22, STAKE_POOL_DISCRIMINATOR, STAKE_POOL_OFFSETS, STAKE_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID, broadcastProblems, decodeStakePool, decodeTokenMetadata,
  encodeSetTokenMetadata, linkProblems, outcomeLine, sameMetadata, setTokenMetadataIx,
  stakeMintFor, targetFor,
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

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const text = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);

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
  const extension = (type, body) => { const head = Buffer.alloc(4); head.writeUInt16LE(type, 0); head.writeUInt16LE(body.length, 2); return Buffer.concat([head, body]); };
  const pointer = extension(18, Buffer.alloc(64));
  const metadata = (m) => extension(19, Buffer.concat([stakePool.toBuffer(), Buffer.alloc(32), text(m.name), text(m.symbol), text(m.uri), u32(0)]));
  const mint = (...extensions) => Buffer.concat([Buffer.alloc(166), ...extensions]);

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
  const image = { status: 200, contentType: 'image/png', firstBytes: '89504e470d0a1a0a' };
  const body = { name: receipt.name, symbol: receipt.symbol, description: receipt.description, image: `${SITE}/mint/img/staked-bayla-00000000.png` };
  const file = (over = {}) => ({ status: 200, contentType: 'application/json; charset=utf-8', text: JSON.stringify(body), ...over });
  const check = (f, i = image) => linkProblems({ token: receipt, file: f, image: i });

  it('passes the file and picture the generator writes', () => {
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
    ['the app page where the picture should be', file(), { status: 200, contentType: 'text/html; charset=utf-8', firstBytes: '3c21646f63747970' }, /not a PNG/],
    ['an unread picture', file(), { error: 'request failed' }, /picture could not be read/],
  ])('refuses %s', (_name, f, i, reason) => {
    const problems = check(f, i);
    expect(problems.join(' | ')).toMatch(reason);
  });
});

describe('a broadcast is refused unless every condition holds', () => {
  const ok = { linkProblems: [], signer: authority, authority, feePayer: authority, simulationError: null, current: null, target };

  it('allows it when all of them hold', () => {
    expect(broadcastProblems(ok)).toEqual([]);
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

  it('still allows a correction: the chain holds a different name', () => {
    expect(broadcastProblems({ ...ok, current: { ...target, name: 'Staked' } })).toEqual([]);
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

  it('says confirmed only on a confirmed status, and reverted only on a read error', () => {
    expect(outcomeLine(SIG, { confirmed: true })).toBe(`confirmed. signature ${SIG}`);
    const reverted = outcomeLine(SIG, { reverted: { InstructionError: [0, { Custom: 6005 }] } });
    expect(reverted).toMatch(/^landed and reverted on chain/);
    expect(reverted).toContain(SIG);
  });
});
