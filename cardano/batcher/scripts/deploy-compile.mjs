// Our deploy's scripts: cardano/minswap-dex-v2 as it stands (the two reviewed patches) with OUR
// seed and pool stake credential, in Minswap's src/script.ts parameter order (the same order
// prove-build.mjs applyMainnet reproduces Minswap's mainnet scripts with), plus the role timelock
// with its Params. The lock's committed plutus.json must be what the pinned compiler builds.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { cbor } from '../../guards/prove-build.mjs';
import { applier, build, checkCompiler, fetchStdlib, stage } from './aiken.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const POOLS = resolve(HERE, '../../minswap-dex-v2');
const LOCK = resolve(HERE, '../../role-timelock');

const txIn = (ref) => {
  const [txId, index] = ref.split('#');
  return cbor.constr(0, [cbor.constr(0, [cbor.bytes(txId)]), cbor.int(Number(index))]);
};
const credential = (c) => cbor.constr(c.type === 'Key' ? 0 : 1, [cbor.bytes(c.hash)]);

/** An address as Plutus Data: Address { payment, Option<Inline(stake)> }. A pointer is refused. */
export function addressData(bech32) {
  const a = CSL.Address.from_bech32(bech32);
  const base = CSL.BaseAddress.from_address(a);
  const ent = CSL.EnterpriseAddress.from_address(a);
  const cred = (c) => (c.kind() === CSL.CredKind.Key ? { type: 'Key', hash: c.to_keyhash().to_hex() } : { type: 'Script', hash: c.to_scripthash().to_hex() });
  if (base) return cbor.constr(0, [credential(cred(base.payment_cred())), cbor.constr(0, [cbor.constr(0, [credential(cred(base.stake_cred()))])])]);
  if (ent) return cbor.constr(0, [credential(cred(ent.payment_cred())), cbor.constr(1, [])]);
  throw new Error(`${bech32}: only a base or enterprise address can be named`);
}

/**
 * p: { seedTxIn, poolStake: {type: 'Key'|'Script', hash}, lockSeedTxIn, ownerA, ownerB, treasury }.
 * Returns every applied script (hash + compiledCode) and the compiler that built them.
 */
export function compileDeployment(p) {
  const version = checkCompiler(HERE);
  const work = mkdtempSync(join(tmpdir(), 'cardano-deploy-'));
  try {
    const stdlib = fetchStdlib(work);
    const dir = stage(POOLS, join(work, 'pools'), stdlib);
    build(dir);
    const { apply, v, pick } = applier(dir);
    apply('authen_minting_policy.validate_authen', txIn(p.seedTxIn));
    const authen = v('authen_minting_policy.validate_authen').hash;
    apply('authen_minting_policy.validate_spend_global_setting', txIn(p.seedTxIn));
    apply('pool_validator.validate_pool', cbor.bytes(authen));
    const pool = v('pool_validator.validate_pool').hash;
    apply('pool_validator.validate_pool_batching', cbor.bytes(authen));
    apply('pool_validator.validate_pool_batching', cbor.constr(1, [cbor.bytes(pool)]));
    const batching = v('pool_validator.validate_pool_batching').hash;
    const expired = v('order_validator.validate_expired_order_cancel').hash;
    const stakeScript = (h) => cbor.constr(0, [cbor.constr(1, [cbor.bytes(h)])]);
    apply('order_validator.validate_order', stakeScript(batching));
    apply('order_validator.validate_order', stakeScript(expired));
    apply('factory_validator.validate_factory', cbor.bytes(authen));
    apply('factory_validator.validate_factory', cbor.constr(0, [cbor.constr(1, [cbor.bytes(pool)]), cbor.constr(0, [cbor.constr(0, [credential(p.poolStake)])])]));
    apply('factory_validator.validate_factory', stakeScript(batching));
    const scripts = {
      authen: pick('authen_minting_policy.validate_authen'),
      globalSetting: pick('authen_minting_policy.validate_spend_global_setting'),
      pool: pick('pool_validator.validate_pool'),
      poolBatching: pick('pool_validator.validate_pool_batching'),
      order: pick('order_validator.validate_order'),
      expiredOrderCancel: pick('order_validator.validate_expired_order_cancel'),
      factory: pick('factory_validator.validate_factory'),
    };
    if (scripts.authen.hash !== scripts.globalSetting.hash) throw new Error('the authen policy and the global setting spend script differ');

    const rt = stage(LOCK, join(work, 'lock'), stdlib);
    const committed = readFileSync(join(rt, 'plutus.json'), 'utf-8');
    build(rt);
    const built = JSON.parse(readFileSync(join(rt, 'plutus.json'), 'utf-8'));
    const same = (a, b) => a.length === b.length && a.every((x, i) => x.title === b[i].title && x.compiledCode === b[i].compiledCode);
    if (!same(built.validators, JSON.parse(committed).validators)) throw new Error("the role timelock's committed plutus.json is not what the pinned compiler builds");
    const lock = applier(rt);
    const params = cbor.constr(0, [txIn(p.lockSeedTxIn), cbor.bytes(p.ownerA), cbor.bytes(p.ownerB), addressData(p.treasury), cbor.bytes(authen)]);
    lock.apply('role_timelock.mint', params);
    lock.apply('role_timelock.spend', params);
    scripts.lock = lock.pick('role_timelock.mint');
    if (lock.pick('role_timelock.spend').hash !== scripts.lock.hash) throw new Error("the lock's mint and spend hashes differ");
    return { compiler: version, scripts };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
