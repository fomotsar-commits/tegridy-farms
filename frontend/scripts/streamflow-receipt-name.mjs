#!/usr/bin/env node
// Names the lighthouse pool's staking receipt through Streamflow's own instruction
// set_token_metadata_t22(name, symbol, uri), with the words from lib/mint-identity.mjs.
//   node scripts/streamflow-receipt-name.mjs [--rpc <url>]        dry run: signs nothing
//   node scripts/streamflow-receipt-name.mjs --broadcast --keypair <file> [--rpc <url>]
// A broadcast is refused unless the link already answers in production, the key is the
// pool's authority and pays the fee, the simulation passed, and the chain differs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { base58 } from '@scure/base';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { redactRpcUrl } from '../../scripts/lib/redact-url.mjs';
import { MINT_TOKENS, SITE, metadataUri } from './lib/mint-identity.mjs';

export const STAKE_PROGRAM_ID = new PublicKey('STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

const anchorDiscriminator = (preimage) => createHash('sha256').update(preimage).digest().subarray(0, 8);
/** ef865b53c439786a. The test holds this to the IDL shipped in @streamflow/staking. */
export const SET_TOKEN_METADATA_T22 = anchorDiscriminator('global:set_token_metadata_t22');
export const STAKE_POOL_DISCRIMINATOR = anchorDiscriminator('account:StakePool');
/** Byte offsets inside a StakePool account. The test re-derives them from the IDL. */
export const STAKE_POOL_OFFSETS = { mint: 10, creator: 42, authority: 74, stakeMint: 171 };
const STAKE_POOL_MIN_BYTES = STAKE_POOL_OFFSETS.stakeMint + 32;

/** The receipt mint of a stake pool: seeds ["stake-mint", pool] under Streamflow's program. */
export function stakeMintFor(stakePool) {
  return PublicKey.findProgramAddressSync([Buffer.from('stake-mint'), stakePool.toBuffer()], STAKE_PROGRAM_ID)[0];
}

/** What this script would write for a receipt row of the one list. */
export function targetFor(token) {
  return { name: token.name, symbol: token.symbol, uri: metadataUri(token.mint) };
}

const borshString = (s) => {
  const body = Buffer.from(s, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([length, body]);
};

/** The instruction's data: the discriminator, then name, symbol and uri, each length-prefixed. */
export function encodeSetTokenMetadata({ name, symbol, uri }) {
  return Buffer.concat([SET_TOKEN_METADATA_T22, borshString(name), borshString(symbol), borshString(uri)]);
}

/**
 * Five accounts in the IDL's order. `authority` is read-only in the IDL, but the program
 * moves rent from it into the mint, so it must also pay the fee (the fee payer is always
 * writable). With another payer the program fails: "writable privilege escalated".
 */
export function setTokenMetadataIx({ authority, stakePool, stakeMint, target }) {
  return new TransactionInstruction({
    programId: STAKE_PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: stakePool, isSigner: false, isWritable: false },
      { pubkey: stakeMint, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeSetTokenMetadata(target),
  });
}

/** The fields this script needs from a StakePool account, or a thrown reason. */
export function decodeStakePool(data) {
  if (data.length < STAKE_POOL_MIN_BYTES) throw new Error(`the stake pool account is ${data.length} bytes, too short to be one`);
  if (!data.subarray(0, 8).equals(STAKE_POOL_DISCRIMINATOR)) throw new Error('the account is not a Streamflow StakePool (wrong first 8 bytes)');
  const key = (at) => new PublicKey(data.subarray(at, at + 32));
  const o = STAKE_POOL_OFFSETS;
  return { mint: key(o.mint), creator: key(o.creator), authority: key(o.authority), stakeMint: key(o.stakeMint) };
}

/**
 * The name, symbol and link stored on a Token-2022 mint, or null when it stores none.
 * Extensions start at byte 166 as (type u16, length u16, body); type 19 is the metadata.
 */
export function decodeTokenMetadata(data) {
  let at = 166;
  while (at + 4 <= data.length) {
    const type = data.readUInt16LE(at);
    const length = data.readUInt16LE(at + 2);
    if (type === 0) return null;
    const body = data.subarray(at + 4, at + 4 + length);
    if (type === 19) {
      let p = 64;
      const text = () => {
        const n = body.readUInt32LE(p);
        p += 4 + n;
        return body.subarray(p - n, p).toString('utf8');
      };
      return { updateAuthority: new PublicKey(body.subarray(0, 32)), name: text(), symbol: text(), uri: text() };
    }
    at += 4 + length;
  }
  return null;
}

export const sameMetadata = (a, b) => Boolean(a && b) && a.name === b.name && a.symbol === b.symbol && a.uri === b.uri;

const PNG_SIGNATURE = '89504e470d0a1a0a';

/**
 * Why the link is not ready to be written on chain, as sentences; none when it is. Takes
 * what was fetched, so the test can hand it the app's HTML page answering 200.
 * `file` and `image` are { status, contentType, text | firstBytes } or { error }.
 */
export function linkProblems({ token, file, image }) {
  const problems = [];
  if (file.error) return [`the link could not be read: ${file.error}`];
  if (file.status !== 200) return [`the link answered HTTP ${file.status}, not 200`];
  if (!/^application\/json\b/i.test(file.contentType ?? '')) problems.push(`the link is served as "${file.contentType}", not JSON`);
  let json;
  try {
    json = JSON.parse(file.text);
  } catch {
    return [...problems, 'the link did not answer with JSON'];
  }
  if (json?.name !== token.name) problems.push(`the file's name is ${JSON.stringify(json?.name)}, not ${JSON.stringify(token.name)}`);
  if (json?.symbol !== token.symbol) problems.push(`the file's symbol is ${JSON.stringify(json?.symbol)}, not ${JSON.stringify(token.symbol)}`);
  if (typeof json?.image !== 'string' || !json.image.startsWith(`${SITE}/`)) {
    return [...problems, `the file's picture is not on ${SITE}`];
  }
  if (!image) return [...problems, 'the picture was not fetched'];
  if (image.error) return [...problems, `the picture could not be read: ${image.error}`];
  if (image.status !== 200) return [...problems, `the picture answered HTTP ${image.status}, not 200`];
  if (!/^image\/png\b/i.test(image.contentType ?? '')) problems.push(`the picture is served as "${image.contentType}", not a PNG`);
  if (image.firstBytes !== PNG_SIGNATURE) problems.push('the picture is not a PNG by its first bytes');
  return problems;
}

/**
 * Every reason a broadcast must not happen, as sentences; none when it may. `current` is
 * the metadata on chain now (null for none), `simulationError` null when it passed.
 */
export function broadcastProblems({ linkProblems: link, signer, authority, feePayer, simulationError, current, target }) {
  const problems = link.map((p) => `the files are not live: ${p}`);
  if (!signer.equals(authority)) problems.push(`the key is ${signer.toBase58()}, and the pool's authority is ${authority.toBase58()}`);
  if (!feePayer.equals(signer)) problems.push('the fee payer is not the signing key; the program moves rent from the authority, so it must pay');
  if (simulationError !== null) problems.push(`the simulation did not pass: ${simulationError}`);
  if (sameMetadata(current, target)) problems.push('the chain already holds this name, symbol and link; there is nothing to write');
  return problems;
}

/**
 * The line printed after a send. `status` is what the chain said about the signature:
 * { confirmed: true }, { reverted: <err> } or null when nothing could be read. An unread
 * answer is never reported as a failure: the transaction may have landed.
 */
export function outcomeLine(signature, status) {
  if (status?.confirmed) return `confirmed. signature ${signature}`;
  if (status?.reverted !== undefined) return `landed and reverted on chain (${JSON.stringify(status.reverted)}). signature ${signature}`;
  return `sent, not confirmed. signature ${signature}. It may still have landed: look the signature up, or run the dry run again, before sending anything else.`;
}

const lamports = (n) => `${Number(n).toLocaleString('en-US')} lamports`;
const sol = (n) => `${(Number(n) / 1e9).toFixed(9)} SOL`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One JSON-RPC call with backoff. A read that never completes throws UNREAD, never a guess. */
function rpcClient(url) {
  return async function rpc(method, params = [], tries = 6) {
    let last = 'no answer';
    for (let i = 0; i < tries; i++) {
      let body = null;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 429 || res.status >= 500) last = `HTTP ${res.status}`;
        else body = await res.json();
      } catch (e) {
        // The message of a failed fetch can carry the endpoint, key and all: print its kind only.
        last = e?.name === 'TimeoutError' ? 'timed out' : 'request failed';
      }
      if (body?.error) {
        const text = JSON.stringify(body.error).slice(0, 600);
        if (/429|rate.?limit|too many/i.test(text)) last = 'rate limited';
        else throw Object.assign(new Error(`${method} was refused: ${text}`), { rejected: true });
      } else if (body && 'result' in body) return body.result;
      await sleep(1_500 * (i + 1));
    }
    throw new Error(`UNREAD ${method}: ${last}`);
  };
}

async function fetchForCheck(url, { bytes = false } = {}) {
  try {
    // No redirect is followed: a link written on chain must answer by itself.
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    const contentType = res.headers.get('content-type');
    if (bytes) return { status: res.status, contentType, firstBytes: Buffer.from(await res.arrayBuffer()).subarray(0, 8).toString('hex') };
    return { status: res.status, contentType, text: await res.text() };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'timed out' : 'request failed' };
  }
}

async function readLink(token) {
  const file = await fetchForCheck(metadataUri(token.mint));
  let image = null;
  try {
    const url = JSON.parse(file.text).image;
    if (typeof url === 'string' && url.startsWith(`${SITE}/`)) image = await fetchForCheck(url, { bytes: true });
  } catch { /* linkProblems reports a file that is not JSON */ }
  return linkProblems({ token, file, image });
}

/** Poll the signature until it is confirmed, reverted, or its blockhash has expired. */
async function waitFor(rpc, signature, lastValidBlockHeight) {
  const read = async (searchTransactionHistory) => {
    const status = (await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory }], 2)).value[0];
    if (!status) return null;
    if (status.err) return { reverted: status.err };
    return ['confirmed', 'finalized'].includes(status.confirmationStatus) ? { confirmed: true } : null;
  };
  // A blockhash lasts about 40 seconds on mainnet; the clock is only a second way out.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const status = await read(false);
      if (status) return status;
      if ((await rpc('getBlockHeight', [{ commitment: 'confirmed' }], 2)) > lastValidBlockHeight) break;
    } catch { /* an unread poll is not an answer: ask again */ }
    await sleep(1_500);
  }
  try {
    return await read(true);
  } catch {
    return null;
  }
}

async function main(argv) {
  const flag = (name) => argv.includes(name);
  const value = (name) => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : undefined);
  const broadcast = flag('--broadcast');
  const rpcUrl = value('--rpc') || process.env.SOLANA_RPC || DEFAULT_RPC;
  const rpc = rpcClient(rpcUrl);
  const say = (label, text) => console.log(`${label.padEnd(15)} ${text}`);

  const receipts = MINT_TOKENS.filter((t) => t.kind === 'staking-receipt');
  const token = value('--mint') ? receipts.find((t) => t.mint === value('--mint')) : receipts.length === 1 ? receipts[0] : null;
  if (!token) throw new Error('name the receipt with --mint <address>: it must be a staking receipt in scripts/lib/mint-identity.mjs');
  if (broadcast && !value('--keypair')) throw new Error('--broadcast needs --keypair <file>');

  const stakePool = new PublicKey(token.stakePool);
  const stakeMint = stakeMintFor(stakePool);
  if (stakeMint.toBase58() !== token.mint) throw new Error(`${token.mint} is not the receipt mint of stake pool ${token.stakePool}`);
  const target = targetFor(token);

  console.log(broadcast ? 'BROADCAST: this run can send one transaction.' : 'DRY RUN: nothing is signed and nothing is sent.');
  say('rpc', redactRpcUrl(rpcUrl));
  const genesis = await rpc('getGenesisHash').catch(() => null);
  say('cluster', genesis === null ? 'UNREAD' : genesis === MAINNET_GENESIS ? 'mainnet-beta' : `NOT mainnet-beta (genesis ${genesis})`);

  const read = await rpc('getMultipleAccounts', [[stakePool.toBase58(), stakeMint.toBase58()], { encoding: 'base64', commitment: 'confirmed' }]);
  const [poolAccount, mintAccount] = read.value;
  if (!poolAccount) throw new Error(`no account at stake pool ${stakePool.toBase58()} on this cluster`);
  if (poolAccount.owner !== STAKE_PROGRAM_ID.toBase58()) throw new Error(`the stake pool is owned by ${poolAccount.owner}, not Streamflow's stake program`);
  const pool = decodeStakePool(Buffer.from(poolAccount.data[0], 'base64'));
  if (!pool.stakeMint.equals(stakeMint)) throw new Error('the pool names a different receipt mint than the one derived from it');
  if (!mintAccount) throw new Error(`no account at receipt mint ${stakeMint.toBase58()}`);
  if (mintAccount.owner !== TOKEN_2022_PROGRAM_ID.toBase58()) throw new Error(`the receipt mint is owned by ${mintAccount.owner}; this script names Token-2022 receipts only`);
  const mintBefore = Buffer.from(mintAccount.data[0], 'base64');
  const current = decodeTokenMetadata(mintBefore);
  const authority = pool.authority;
  const authorityAccount = (await rpc('getAccountInfo', [authority.toBase58(), { encoding: 'base64', commitment: 'confirmed' }])).value;

  say('stake pool', `${stakePool.toBase58()} (stakes ${pool.mint.toBase58()}), read at slot ${read.context.slot.toLocaleString('en-US')}`);
  say('receipt mint', stakeMint.toBase58());
  say('pool authority', `${authority.toBase58()}, holding ${authorityAccount ? sol(authorityAccount.lamports) : 'nothing: the account does not exist'}`);
  say('on chain now', current ? `name ${JSON.stringify(current.name)}, symbol ${JSON.stringify(current.symbol)}, link ${current.uri}` : 'no name, no symbol, no link');
  say('would write', `name ${JSON.stringify(target.name)}, symbol ${JSON.stringify(target.symbol)}, link ${target.uri}`);
  if (sameMetadata(current, target)) say('change', 'none: the chain already holds exactly this');

  const ix = setTokenMetadataIx({ authority, stakePool, stakeMint, target });
  const unsigned = new Transaction().add(ix);
  unsigned.feePayer = authority;
  unsigned.recentBlockhash = PublicKey.default.toBase58();
  const sim = (await rpc('simulateTransaction', [
    unsigned.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', encoding: 'base64', accounts: { encoding: 'base64', addresses: [stakeMint.toBase58()] } },
  ])).value;
  const simulationError = sim.err === null ? null : JSON.stringify(sim.err);
  say('simulation', simulationError === null ? `passed, ${Number(sim.unitsConsumed).toLocaleString('en-US')} compute units, fee payer ${authority.toBase58()}` : `DID NOT PASS: ${simulationError}`);
  for (const line of sim.logs ?? []) console.log(`                  ${line}`);

  const { blockhash } = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
  unsigned.recentBlockhash = blockhash;
  const fee = await rpc('getFeeForMessage', [unsigned.compileMessage().serialize().toString('base64'), { commitment: 'confirmed' }])
    .then((r) => r.value)
    .catch(() => null);
  if (simulationError === null && sim.accounts?.[0]) {
    const after = Buffer.from(sim.accounts[0].data[0], 'base64');
    const rent = sim.accounts[0].lamports - mintAccount.lamports;
    const written = decodeTokenMetadata(after);
    say('mint account', `${mintBefore.length} bytes now, ${after.length} bytes after`);
    say('after', written ? `name ${JSON.stringify(written.name)}, symbol ${JSON.stringify(written.symbol)}, link ${written.uri}, editable only through pool ${written.updateAuthority.toBase58()}` : 'UNREAD: the simulated mint shows no metadata');
    say('cost', fee === null
      ? `${lamports(rent)} of rent moved into the mint, plus a network fee that could not be read (UNREAD)`
      : `${lamports(rent)} of rent moved into the mint + ${lamports(fee)} network fee = ${lamports(rent + fee)} (${sol(rent + fee)}), paid by the pool authority`);
  }

  const link = await readLink(token);
  say('files', link.length === 0 ? `live: ${target.uri} answers with this name, symbol and a real PNG` : 'NOT LIVE YET');
  for (const p of link) console.log(`                  ${p}`);

  if (!broadcast) {
    console.log('\nDry run only. Nothing was signed or sent.');
    if (link.length > 0) console.log('A broadcast would be refused until the files answer in production.');
    return;
  }

  // The key file is opened only here, on a broadcast. Its address is the one thing printed:
  // a parse error can quote the file, so the error is replaced, never passed on.
  let signer;
  try {
    signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(value('--keypair'), 'utf8'))));
  } catch {
    throw new Error('the --keypair file could not be read as a Solana id.json (an array of 64 numbers)');
  }
  const problems = broadcastProblems({ linkProblems: link, signer: signer.publicKey, authority, feePayer: signer.publicKey, simulationError, current, target });
  if (problems.length > 0) {
    console.log('\nREFUSED. Nothing was signed or sent:');
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  // Everything slow is done. A blockhash lasts about 40 seconds, so take it last.
  const latest = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
  const tx = new Transaction().add(setTokenMetadataIx({ authority: signer.publicKey, stakePool, stakeMint, target }));
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(signer);
  const signature = base58.encode(tx.signature);
  try {
    await rpc('sendTransaction', [tx.serialize().toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }], 2);
  } catch (e) {
    if (e.rejected) {
      console.log(`\nNOT SENT. The node refused the transaction before sending it: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    // The node's answer was not read, so it may have taken the transaction: go and look.
  }
  const line = outcomeLine(signature, await waitFor(rpc, signature, latest.lastValidBlockHeight));
  console.log(`\n${line}`);
  if (!line.startsWith('confirmed')) process.exitCode = 1;
}

// Only when run as a program. The tests import the pure pieces above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`\nERROR: ${e.message}`);
    process.exitCode = 1;
  });
}
