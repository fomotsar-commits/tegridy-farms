//// Every path of the lock passing, then each way to act early, with one key,
//// or with a change other than the one announced. Each refused case is a
//// passing case with one thing changed. Where Minswap's own checks would let
//// that transaction through, a `minswap_` test runs them on it: the lock is
//// what stops it.

use aiken/dict
use aiken/interval
use aiken/list
use aiken/transaction.{
  InlineDatum, Input, Mint, NoDatum, Output, OutputReference, ScriptContext,
  Spend, Transaction, TransactionId,
}
use aiken/transaction/credential.{
  Address, Inline, ScriptCredential, VerificationKeyCredential,
}
use aiken/transaction/value.{Value}
use amm_dex_v2/pool_validation
use amm_dex_v2/types.{
  Asset, GlobalSetting, PAMSignature, PAMSpendScript, PoolDatum,
  UpdateDynamicFee, UpdatePoolFee, UpdatePoolStakeCredential,
} as minswap
use amm_dex_v2/utils
use role_timelock/lock
use role_timelock/types.{
  Announce, Announcement, Cancel, Change, Execute, Params, SetGlobalSetting,
  SetPool, State, WithdrawFeeSharing,
}

const lock_hash = #"10101010101010101010101010101010101010101010101010101010"

const authen = #"20202020202020202020202020202020202020202020202020202020"

const pool_hash = #"30303030303030303030303030303030303030303030303030303030"

const token_policy = #"40404040404040404040404040404040404040404040404040404040"

const token_name = #"544f4b"

const pool_stake = #"50505050505050505050505050505050505050505050505050505050"

const other_stake = #"51515151515151515151515151515151515151515151515151515151"

const owner_a = #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

const owner_b = #"b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"

const stranger = #"e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0"

/// 2026-11-01 00:00 UTC.
const now = 1793491200000

const minute = 60000

// The pool's fee share not yet withdrawn: 7 ADA and 9,000 TOK.
const earned_a = 7000000

const earned_b = 9000

fn params() -> Params {
  Params {
    seed: OutputReference {
      transaction_id: TransactionId {
        hash: #"0101010101010101010101010101010101010101010101010101010101010101",
      },
      output_index: 0,
    },
    owner_a,
    owner_b,
    treasury: treasury(),
    authen_policy_id: authen,
  }
}

fn treasury() -> Address {
  Address {
    payment_credential: ScriptCredential(
      #"70707070707070707070707070707070707070707070707070707070",
    ),
    stake_credential: None,
  }
}

fn wallet(key: ByteArray) -> Address {
  Address {
    payment_credential: VerificationKeyCredential(key),
    stake_credential: None,
  }
}

fn utxo(n: Int) -> OutputReference {
  OutputReference {
    transaction_id: TransactionId {
      hash: #"0202020202020202020202020202020202020202020202020202020202020202",
    },
    output_index: n,
  }
}

fn empty() -> State {
  State { announced: [] }
}

fn lock_value() -> Value {
  value.from_lovelace(2000000)
    |> value.add(lock_hash, lock.lock_token_name, 1)
}

fn lock_out(state: State) -> Output {
  Output {
    address: Address {
      payment_credential: ScriptCredential(lock_hash),
      stake_credential: None,
    },
    value: lock_value(),
    datum: InlineDatum(state),
    reference_script: None,
  }
}

fn lock_in(state: State) -> Input {
  Input { output_reference: utxo(0), output: lock_out(state) }
}

fn wallet_in() -> Input {
  Input {
    output_reference: utxo(1),
    output: Output {
      address: wallet(owner_a),
      value: value.from_lovelace(50000000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

// --- Minswap's pool and GlobalSetting, as its validators read them ---------

fn ada() -> Asset {
  Asset { policy_id: #"", asset_name: #"" }
}

fn tok() -> Asset {
  Asset { policy_id: token_policy, asset_name: token_name }
}

fn pool_address(stake: ByteArray) -> Address {
  Address {
    payment_credential: ScriptCredential(pool_hash),
    stake_credential: Some(Inline(VerificationKeyCredential(stake))),
  }
}

fn pool_datum() -> PoolDatum {
  PoolDatum {
    pool_batching_stake_credential: Inline(
      ScriptCredential(
        #"60606060606060606060606060606060606060606060606060606060",
      ),
    ),
    asset_a: ada(),
    asset_b: tok(),
    total_liquidity: 1000000000,
    reserve_a: 1000000000,
    reserve_b: 2000000000,
    base_fee_a_numerator: 30,
    base_fee_b_numerator: 30,
    fee_sharing_numerator_opt: None,
    allow_dynamic_fee: False,
  }
}

/// Its reserves, Minswap's minimum ADA, its NFT, and fee share not yet taken.
fn pool_value(share_a: Int, share_b: Int) -> Value {
  value.from_lovelace(1000000000 + utils.min_pool_ada + share_a)
    |> value.add(token_policy, token_name, 2000000000 + share_b)
    |> value.add(authen, utils.pool_auth_asset_name, 1)
}

fn pool_out(datum: PoolDatum, stake: ByteArray, v: Value) -> Output {
  Output {
    address: pool_address(stake),
    value: v,
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn pool_in() -> Input {
  Input {
    output_reference: utxo(2),
    output: pool_out(pool_datum(), pool_stake, pool_value(earned_a, earned_b)),
  }
}

/// The pool with the venue's fee share switched on: 1333 / 10000 of the fee,
/// the owner's rate, under the floor our one patch to Minswap lowers.
fn shared() -> PoolDatum {
  PoolDatum { ..pool_datum(), fee_sharing_numerator_opt: Some(1333) }
}

fn set_pool(after: PoolDatum, stake: ByteArray) -> Change {
  SetPool {
    asset_a: after.asset_a,
    asset_b: after.asset_b,
    base_fee_a_numerator: after.base_fee_a_numerator,
    base_fee_b_numerator: after.base_fee_b_numerator,
    fee_sharing_numerator_opt: after.fee_sharing_numerator_opt,
    allow_dynamic_fee: after.allow_dynamic_fee,
    stake_credential: Some(Inline(VerificationKeyCredential(stake))),
  }
}

fn setting(batcher: ByteArray) -> GlobalSetting {
  GlobalSetting {
    batchers: [PAMSignature(batcher)],
    pool_fee_updater: PAMSpendScript(lock_hash),
    fee_sharing_taker: PAMSpendScript(lock_hash),
    pool_stake_key_updater: PAMSpendScript(lock_hash),
    pool_dynamic_fee_updater: PAMSpendScript(lock_hash),
    admin: PAMSpendScript(lock_hash),
    pool_creation_fee: 73000000,
    pool_creation_fee_receiver: treasury(),
  }
}

const batcher = #"61616161616161616161616161616161616161616161616161616161"

const new_batcher = #"62626262626262626262626262626262626262626262626262626262"

fn setting_out(s: GlobalSetting) -> Output {
  Output {
    address: Address {
      payment_credential: ScriptCredential(authen),
      stake_credential: None,
    },
    value: value.from_lovelace(2000000)
      |> value.add(authen, utils.global_setting_asset_name, 1),
    datum: InlineDatum(s),
    reference_script: None,
  }
}

fn setting_in() -> Input {
  Input { output_reference: utxo(3), output: setting_out(setting(batcher)) }
}

// --- Transactions ----------------------------------------------------------

fn spend_ctx(
  inputs: List<Input>,
  outputs: List<Output>,
  from: Int,
  to: Int,
) -> ScriptContext {
  ScriptContext {
    transaction: Transaction {
      ..transaction.placeholder(),
      inputs: inputs,
      outputs: outputs,
      extra_signatories: [owner_a, owner_b],
      validity_range: interval.between(from, to),
    },
    purpose: Spend(utxo(0)),
  }
}

fn signed(ctx: ScriptContext, signers: List<ByteArray>) -> ScriptContext {
  ScriptContext {
    ..ctx,
    transaction: Transaction { ..ctx.transaction, extra_signatories: signers },
  }
}

fn inputs(ctx: ScriptContext, ins: List<Input>) -> ScriptContext {
  ScriptContext {
    ..ctx,
    transaction: Transaction { ..ctx.transaction, inputs: ins },
  }
}

fn outputs(ctx: ScriptContext, outs: List<Output>) -> ScriptContext {
  ScriptContext {
    ..ctx,
    transaction: Transaction { ..ctx.transaction, outputs: outs },
  }
}

fn range(ctx: ScriptContext, r: interval.Interval<Int>) -> ScriptContext {
  ScriptContext {
    ..ctx,
    transaction: Transaction { ..ctx.transaction, validity_range: r },
  }
}

/// Minswap's pool validator on `UpdatePoolParameters`, its roles all the lock:
/// the role is present, the pool is the only other script spent, and the
/// pool's change is within Minswap's own rules.
fn minswap_updates_pool(ctx: ScriptContext, action) -> Bool {
  let tx = ctx.transaction
  and {
    utils.authorize_pool_license(
      PAMSpendScript(lock_hash),
      tx.inputs,
      dict.new(),
      tx.extra_signatories,
    ),
    pool_validation.has_only_pool_and_author(
      tx.inputs,
      pool_address(pool_stake),
      PAMSpendScript(lock_hash),
    ),
    pool_validation.validate_update_pool_parameters(
      action,
      authen,
      pool_in(),
      pool_datum(),
      tx.outputs,
    ),
  }
}

/// Minswap's pool validator on `WithdrawFeeSharing`.
fn minswap_withdraws(ctx: ScriptContext) -> Bool {
  let tx = ctx.transaction
  and {
    utils.authorize_pool_license(
      PAMSpendScript(lock_hash),
      tx.inputs,
      dict.new(),
      tx.extra_signatories,
    ),
    pool_validation.has_only_pool_and_author(
      tx.inputs,
      pool_address(pool_stake),
      PAMSpendScript(lock_hash),
    ),
    pool_validation.validate_withdraw_fee_sharing(
      authen,
      pool_in(),
      pool_datum(),
      tx.outputs,
    ),
  }
}

/// The admin check in Minswap's GlobalSetting validator.
fn minswap_admin_present(ctx: ScriptContext) -> Bool {
  utils.authorize_pool_license(
    PAMSpendScript(lock_hash),
    ctx.transaction.inputs,
    dict.new(),
    ctx.transaction.extra_signatories,
  )
}

// --- Mint: the lock token, once -------------------------------------------

fn seed_in() -> Input {
  Input { ..wallet_in(), output_reference: params().seed }
}

fn mint_ctx() -> ScriptContext {
  ScriptContext {
    transaction: Transaction {
      ..transaction.placeholder(),
      inputs: [seed_in()],
      outputs: [lock_out(empty())],
      mint: value.to_minted_value(
        value.from_asset(lock_hash, lock.lock_token_name, 1),
      ),
      extra_signatories: [owner_a, owner_b],
    },
    purpose: Mint(lock_hash),
  }
}

fn minting(ctx: ScriptContext, v: Value) -> ScriptContext {
  ScriptContext {
    ..ctx,
    transaction: Transaction {
      ..ctx.transaction,
      mint: value.to_minted_value(v),
    },
  }
}

test mint_once() {
  lock.mint(params(), mint_ctx())
}

test mint_needs_the_seed() fail {
  lock.mint(params(), inputs(mint_ctx(), [wallet_in()]))
}

test mint_key_a_alone() fail {
  lock.mint(params(), signed(mint_ctx(), [owner_a]))
}

test mint_key_b_alone() fail {
  lock.mint(params(), signed(mint_ctx(), [owner_b]))
}

test mint_two_tokens() fail {
  let v = value.from_asset(lock_hash, lock.lock_token_name, 2)
  lock.mint(
    params(),
    outputs(
      minting(mint_ctx(), v),
      [
        Output {
          ..lock_out(empty()),
          value: value.add(lock_value(), lock_hash, lock.lock_token_name, 1),
        },
      ],
    ),
  )
}

test mint_another_name_too() fail {
  let v =
    value.from_asset(lock_hash, lock.lock_token_name, 1)
      |> value.add(lock_hash, #"6f74686572", 1)
  lock.mint(params(), minting(mint_ctx(), v))
}

// A lock born holding an announcement already "48 hours old" would skip the wait.
test mint_with_a_history() fail {
  let forged =
    State {
      announced: [
        Announcement {
          change: SetGlobalSetting(setting(stranger)),
          ready_at: 0,
        },
      ],
    }
  lock.mint(params(), outputs(mint_ctx(), [lock_out(forged)]))
}

test mint_into_a_wallet() fail {
  lock.mint(
    params(),
    outputs(
      mint_ctx(),
      [Output { ..lock_out(empty()), address: wallet(owner_a) }],
    ),
  )
}

test mint_same_key_twice() fail {
  lock.mint(
    Params { ..params(), owner_b: owner_a },
    signed(mint_ctx(), [owner_a]),
  )
}

// --- Announce ---------------------------------------------------------------

fn fee_on() -> Announcement {
  Announcement {
    change: set_pool(shared(), pool_stake),
    ready_at: now + lock.delay,
  }
}

fn announce_ctx() -> ScriptContext {
  spend_ctx(
    [lock_in(empty()), wallet_in()],
    [lock_out(State { announced: [fee_on()] })],
    now - 10 * minute,
    now,
  )
}

fn announce(ctx: ScriptContext) -> Bool {
  lock.spend(params(), empty(), Announce { announcement: fee_on() }, ctx)
}

test announce_adds_one() {
  announce(announce_ctx())
}

test announce_appends() {
  let before = State { announced: [fee_on(), fee_on()] }
  let after = State { announced: [fee_on(), fee_on(), fee_on()] }
  lock.spend(
    params(),
    before,
    Announce { announcement: fee_on() },
    spend_ctx(
      [lock_in(before), wallet_in()],
      [lock_out(after)],
      now - 10 * minute,
      now,
    ),
  )
}

test announce_one_ms_short_of_48_hours() fail {
  announce(range(announce_ctx(), interval.between(now - 10 * minute, now + 1)))
}

test announce_with_no_latest_time() fail {
  announce(range(announce_ctx(), interval.after(now - 10 * minute)))
}

test announce_key_a_alone() fail {
  announce(signed(announce_ctx(), [owner_a]))
}

test announce_key_b_alone() fail {
  announce(signed(announce_ctx(), [owner_b]))
}

test announce_key_a_and_a_stranger() fail {
  announce(signed(announce_ctx(), [owner_a, stranger]))
}

test announce_no_keys() fail {
  announce(signed(announce_ctx(), []))
}

// The redeemer says 48 hours; the lock would store a time already past.
test announce_stores_an_earlier_time() fail {
  let stored = Announcement { ..fee_on(), ready_at: now }
  announce(outputs(announce_ctx(), [lock_out(State { announced: [stored] })]))
}

test announce_rewrites_what_was_announced() fail {
  let before = State { announced: [fee_on()] }
  lock.spend(
    params(),
    before,
    Announce { announcement: fee_on() },
    spend_ctx(
      [lock_in(before), wallet_in()],
      [lock_out(State { announced: [fee_on()] })],
      now - 10 * minute,
      now,
    ),
  )
}

fn sneaked_fee() -> List<Output> {
  [
    lock_out(State { announced: [fee_on()] }),
    pool_out(shared(), pool_stake, pool_value(earned_a, earned_b)),
  ]
}

// Spending the lock makes Minswap's roles present, so the announcement itself
// could carry an unannounced pool change.
test announce_while_changing_a_pool() fail {
  announce(
    outputs(
      inputs(announce_ctx(), [lock_in(empty()), pool_in(), wallet_in()]),
      sneaked_fee(),
    ),
  )
}

test minswap_would_take_that_pool_change() {
  minswap_updates_pool(
    outputs(
      inputs(announce_ctx(), [lock_in(empty()), pool_in(), wallet_in()]),
      sneaked_fee(),
    ),
    UpdatePoolFee,
  )
}

test announce_while_changing_the_setting() fail {
  announce(
    outputs(
      inputs(announce_ctx(), [lock_in(empty()), setting_in(), wallet_in()]),
      [
        setting_out(setting(stranger)),
        lock_out(State { announced: [fee_on()] }),
      ],
    ),
  )
}

test announce_into_a_full_list() fail {
  let full = State { announced: list.repeat(fee_on(), lock.max_announced) }
  let over = State { announced: list.repeat(fee_on(), lock.max_announced + 1) }
  lock.spend(
    params(),
    full,
    Announce { announcement: fee_on() },
    spend_ctx(
      [lock_in(full), wallet_in()],
      [lock_out(over)],
      now - 10 * minute,
      now,
    ),
  )
}

test announce_the_last_place() {
  let almost =
    State { announced: list.repeat(fee_on(), lock.max_announced - 1) }
  let full = State { announced: list.repeat(fee_on(), lock.max_announced) }
  lock.spend(
    params(),
    almost,
    Announce { announcement: fee_on() },
    spend_ctx(
      [lock_in(almost), wallet_in()],
      [lock_out(full)],
      now - 10 * minute,
      now,
    ),
  )
}

test announce_sends_the_token_away() fail {
  announce(
    outputs(
      announce_ctx(),
      [
        Output {
          ..lock_out(State { announced: [fee_on()] }),
          address: wallet(owner_a),
        },
      ],
    ),
  )
}

test announce_adds_a_token_to_the_lock() fail {
  let o = lock_out(State { announced: [fee_on()] })
  announce(
    outputs(
      announce_ctx(),
      [Output { ..o, value: value.add(o.value, token_policy, token_name, 1) }],
    ),
  )
}

test announce_gives_the_lock_a_stake_key() fail {
  let o = lock_out(State { announced: [fee_on()] })
  announce(
    outputs(
      announce_ctx(),
      [
        Output {
          ..o,
          address: Address {
            ..o.address,
            stake_credential: Some(Inline(VerificationKeyCredential(stranger))),
          },
        },
      ],
    ),
  )
}

test announce_gives_the_lock_a_reference_script() fail {
  let o = lock_out(State { announced: [fee_on()] })
  announce(
    outputs(announce_ctx(), [Output { ..o, reference_script: Some(lock_hash) }]),
  )
}

// The token cannot leave the lock, not even by burning: a burn needs the seed.
test announce_burning_the_lock_token() fail {
  announce(outputs(announce_ctx(), []))
}

// --- Cancel -----------------------------------------------------------------

fn two() -> State {
  State {
    announced: [
      fee_on(),
      Announcement { ..fee_on(), ready_at: now + lock.delay + 1 },
    ],
  }
}

fn cancel_ctx() -> ScriptContext {
  spend_ctx(
    [lock_in(two()), wallet_in()],
    [lock_out(State { announced: list.drop(two().announced, 1) })],
    now - 10 * minute,
    now,
  )
}

test cancel_removes_one() {
  lock.spend(params(), two(), Cancel { index: 0 }, cancel_ctx())
}

test cancel_the_second() {
  lock.spend(
    params(),
    two(),
    Cancel { index: 1 },
    outputs(
      cancel_ctx(),
      [lock_out(State { announced: list.take(two().announced, 1) })],
    ),
  )
}

test cancel_key_a_alone() fail {
  lock.spend(
    params(),
    two(),
    Cancel { index: 0 },
    signed(cancel_ctx(), [owner_a]),
  )
}

test cancel_removes_another() fail {
  lock.spend(params(), two(), Cancel { index: 1 }, cancel_ctx())
}

test cancel_past_the_end() fail {
  lock.spend(
    params(),
    two(),
    Cancel { index: 2 },
    outputs(cancel_ctx(), [lock_out(two())]),
  )
}

test cancel_before_the_start() fail {
  lock.spend(
    params(),
    two(),
    Cancel { index: -1 },
    outputs(cancel_ctx(), [lock_out(two())]),
  )
}

test cancel_while_changing_a_pool() fail {
  lock.spend(
    params(),
    two(),
    Cancel { index: 0 },
    outputs(
      inputs(cancel_ctx(), [lock_in(two()), pool_in(), wallet_in()]),
      [
        lock_out(State { announced: list.drop(two().announced, 1) }),
        pool_out(shared(), pool_stake, pool_value(earned_a, earned_b)),
      ],
    ),
  )
}

// --- Execute a pool change --------------------------------------------------

fn ready(change: Change) -> State {
  State { announced: [Announcement { change, ready_at: now }] }
}

fn fee_tx(after: PoolDatum) -> ScriptContext {
  spend_ctx(
    [lock_in(ready(set_pool(shared(), pool_stake))), pool_in(), wallet_in()],
    [
      pool_out(after, pool_stake, pool_value(earned_a, earned_b)),
      lock_out(empty()),
    ],
    now,
    now + 10 * minute,
  )
}

fn execute_fee(ctx: ScriptContext) -> Bool {
  lock.spend(
    params(),
    ready(set_pool(shared(), pool_stake)),
    Execute { index: 0 },
    ctx,
  )
}

test execute_pool_fee() {
  execute_fee(fee_tx(shared()))
}

test minswap_takes_the_pool_fee_change() {
  minswap_updates_pool(fee_tx(shared()), UpdatePoolFee)
}

// The patched floor is 1333 exactly: one less is still refused by Minswap.
test minswap_refuses_a_share_under_the_floor() fail {
  let under =
    PoolDatum { ..pool_datum(), fee_sharing_numerator_opt: Some(1332) }
  minswap_updates_pool(
    inputs(
      fee_tx(under),
      [lock_in(ready(set_pool(under, pool_stake))), pool_in(), wallet_in()],
    ),
    UpdatePoolFee,
  )
}

test execute_one_ms_early() fail {
  execute_fee(
    range(fee_tx(shared()), interval.between(now - 1, now + 10 * minute)),
  )
}

test execute_with_no_earliest_time() fail {
  execute_fee(range(fee_tx(shared()), interval.before(now + 10 * minute)))
}

test execute_after_the_window() fail {
  execute_fee(
    range(
      fee_tx(shared()),
      interval.between(now + 10 * minute, now + lock.grace + 1),
    ),
  )
}

test execute_at_the_end_of_the_window() {
  execute_fee(
    range(
      fee_tx(shared()),
      interval.between(now + lock.grace - minute, now + lock.grace),
    ),
  )
}

test execute_key_a_alone() fail {
  execute_fee(signed(fee_tx(shared()), [owner_a]))
}

test execute_key_b_alone() fail {
  execute_fee(signed(fee_tx(shared()), [owner_b]))
}

// CertiK's MIN-01: a role-holder sets a fee share nobody was told about.
fn other_share() -> PoolDatum {
  PoolDatum { ..pool_datum(), fee_sharing_numerator_opt: Some(5000) }
}

test execute_a_fee_other_than_announced() fail {
  execute_fee(fee_tx(other_share()))
}

test minswap_would_take_the_other_fee() {
  minswap_updates_pool(fee_tx(other_share()), UpdatePoolFee)
}

test execute_a_trade_fee_a_other_than_announced() fail {
  execute_fee(fee_tx(PoolDatum { ..shared(), base_fee_a_numerator: 2000 }))
}

test execute_a_trade_fee_b_other_than_announced() fail {
  execute_fee(fee_tx(PoolDatum { ..shared(), base_fee_b_numerator: 2000 }))
}

test minswap_would_take_the_other_trade_fee() {
  minswap_updates_pool(
    fee_tx(PoolDatum { ..shared(), base_fee_b_numerator: 2000 }),
    UpdatePoolFee,
  )
}

fn dynamic_tx(after: PoolDatum) -> ScriptContext {
  inputs(
    outputs(
      fee_tx(after),
      [
        pool_out(after, pool_stake, pool_value(earned_a, earned_b)),
        lock_out(empty()),
      ],
    ),
    [lock_in(ready(set_pool(pool_datum(), pool_stake))), pool_in(), wallet_in()],
  )
}

test execute_a_dynamic_fee_switch_not_announced() fail {
  lock.spend(
    params(),
    ready(set_pool(pool_datum(), pool_stake)),
    Execute { index: 0 },
    dynamic_tx(PoolDatum { ..pool_datum(), allow_dynamic_fee: True }),
  )
}

test minswap_would_take_the_dynamic_fee_switch() {
  minswap_updates_pool(
    dynamic_tx(PoolDatum { ..pool_datum(), allow_dynamic_fee: True }),
    UpdateDynamicFee,
  )
}

test execute_on_a_pool_with_another_asset_a() fail {
  let elsewhere =
    PoolDatum {
      ..shared(),
      asset_a: Asset { policy_id: token_policy, asset_name: #"41" },
    }
  lock.spend(
    params(),
    ready(set_pool(elsewhere, pool_stake)),
    Execute { index: 0 },
    inputs(
      fee_tx(shared()),
      [lock_in(ready(set_pool(elsewhere, pool_stake))), pool_in(), wallet_in()],
    ),
  )
}

test execute_on_another_pool() fail {
  let elsewhere =
    PoolDatum {
      ..shared(),
      asset_b: Asset { ..tok(), asset_name: #"4f54484552" },
    }
  lock.spend(
    params(),
    ready(set_pool(elsewhere, pool_stake)),
    Execute { index: 0 },
    inputs(
      fee_tx(shared()),
      [lock_in(ready(set_pool(elsewhere, pool_stake))), pool_in(), wallet_in()],
    ),
  )
}

fn stake_tx(to: ByteArray) -> ScriptContext {
  spend_ctx(
    [
      lock_in(ready(set_pool(pool_datum(), other_stake))),
      pool_in(),
      wallet_in(),
    ],
    [
      pool_out(pool_datum(), to, pool_value(earned_a, earned_b)),
      lock_out(empty()),
    ],
    now,
    now + 10 * minute,
  )
}

fn execute_stake(ctx: ScriptContext) -> Bool {
  lock.spend(
    params(),
    ready(set_pool(pool_datum(), other_stake)),
    Execute { index: 0 },
    ctx,
  )
}

test execute_the_announced_stake_key() {
  execute_stake(stake_tx(other_stake))
}

test execute_a_stake_key_other_than_announced() fail {
  execute_stake(stake_tx(stranger))
}

test minswap_would_take_the_other_stake_key() {
  minswap_updates_pool(stake_tx(stranger), UpdatePoolStakeCredential)
}

// A no-op change announced, then made with the earned share taken elsewhere.
test execute_carries_a_withdrawal() fail {
  let same = ready(set_pool(pool_datum(), pool_stake))
  lock.spend(
    params(),
    same,
    Execute { index: 0 },
    spend_ctx(
      [lock_in(same), pool_in(), wallet_in()],
      [
        pool_out(pool_datum(), pool_stake, pool_value(0, 0)),
        lock_out(empty()),
        Output {
          ..lock_out(empty()),
          address: wallet(stranger),
          value: value.from_lovelace(earned_a)
            |> value.add(token_policy, token_name, earned_b),
        },
      ],
      now,
      now + 10 * minute,
    ),
  )
}

test execute_keeps_the_announcement() fail {
  execute_fee(
    outputs(
      fee_tx(shared()),
      [
        pool_out(shared(), pool_stake, pool_value(earned_a, earned_b)),
        lock_out(ready(set_pool(shared(), pool_stake))),
      ],
    ),
  )
}

test execute_past_the_end() fail {
  lock.spend(
    params(),
    ready(set_pool(shared(), pool_stake)),
    Execute { index: 1 },
    fee_tx(shared()),
  )
}

test execute_before_the_start() fail {
  lock.spend(
    params(),
    ready(set_pool(shared(), pool_stake)),
    Execute { index: -1 },
    fee_tx(shared()),
  )
}

test execute_two_pools() fail {
  let second = Input { ..pool_in(), output_reference: utxo(4) }
  execute_fee(
    outputs(
      inputs(
        fee_tx(shared()),
        [
          lock_in(ready(set_pool(shared(), pool_stake))),
          pool_in(),
          second,
          wallet_in(),
        ],
      ),
      [
        pool_out(shared(), pool_stake, pool_value(earned_a, earned_b)),
        pool_out(shared(), pool_stake, pool_value(earned_a, earned_b)),
        lock_out(empty()),
      ],
    ),
  )
}

test execute_pool_fee_while_moving_the_setting() fail {
  execute_fee(
    outputs(
      inputs(
        fee_tx(shared()),
        [
          lock_in(ready(set_pool(shared(), pool_stake))),
          pool_in(),
          setting_in(),
          wallet_in(),
        ],
      ),
      [
        pool_out(shared(), pool_stake, pool_value(earned_a, earned_b)),
        setting_out(setting(stranger)),
        lock_out(empty()),
      ],
    ),
  )
}

test execute_a_pool_change_on_the_setting() fail {
  execute_fee(
    outputs(
      inputs(
        fee_tx(shared()),
        [
          lock_in(ready(set_pool(shared(), pool_stake))),
          setting_in(),
          wallet_in(),
        ],
      ),
      [setting_out(setting(stranger)), lock_out(empty())],
    ),
  )
}

// --- Execute a GlobalSetting change -----------------------------------------

fn setting_tx(new: GlobalSetting) -> ScriptContext {
  spend_ctx(
    [
      lock_in(ready(SetGlobalSetting(setting(new_batcher)))),
      setting_in(),
      wallet_in(),
    ],
    [setting_out(new), lock_out(empty())],
    now,
    now + 10 * minute,
  )
}

fn execute_setting(ctx: ScriptContext) -> Bool {
  lock.spend(
    params(),
    ready(SetGlobalSetting(setting(new_batcher))),
    Execute { index: 0 },
    ctx,
  )
}

test execute_the_announced_setting() {
  execute_setting(setting_tx(setting(new_batcher)))
}

test minswap_takes_the_setting_change() {
  minswap_admin_present(setting_tx(setting(new_batcher)))
}

// MIN-01 again: the fee share's taker swapped for a stranger's key.
test execute_a_setting_other_than_announced() fail {
  execute_setting(
    setting_tx(
      GlobalSetting {
        ..setting(new_batcher),
        fee_sharing_taker: PAMSignature(stranger),
      },
    ),
  )
}

test minswap_would_take_the_other_setting() {
  minswap_admin_present(
    setting_tx(
      GlobalSetting {
        ..setting(new_batcher),
        fee_sharing_taker: PAMSignature(stranger),
      },
    ),
  )
}

test execute_the_setting_early() fail {
  execute_setting(
    range(
      setting_tx(setting(new_batcher)),
      interval.between(now - 1, now + 10 * minute),
    ),
  )
}

test execute_the_setting_key_b_alone() fail {
  execute_setting(signed(setting_tx(setting(new_batcher)), [owner_b]))
}

test execute_the_setting_while_moving_a_pool() fail {
  execute_setting(
    outputs(
      inputs(
        setting_tx(setting(new_batcher)),
        [
          lock_in(ready(SetGlobalSetting(setting(new_batcher)))),
          setting_in(),
          pool_in(),
          wallet_in(),
        ],
      ),
      [
        setting_out(setting(new_batcher)),
        pool_out(other_share(), pool_stake, pool_value(earned_a, earned_b)),
        lock_out(empty()),
      ],
    ),
  )
}

test execute_a_setting_change_on_a_pool() fail {
  execute_setting(
    outputs(
      inputs(
        setting_tx(setting(new_batcher)),
        [
          lock_in(ready(SetGlobalSetting(setting(new_batcher)))),
          pool_in(),
          wallet_in(),
        ],
      ),
      [
        pool_out(other_share(), pool_stake, pool_value(earned_a, earned_b)),
        lock_out(empty()),
      ],
    ),
  )
}

// --- The pool creation fee, re-set by hand ------------------------------------

/// `new` announced, ready, and made exactly.
fn execute_announced(new: GlobalSetting) -> Bool {
  lock.spend(
    params(),
    ready(SetGlobalSetting(new)),
    Execute { index: 0 },
    spend_ctx(
      [lock_in(ready(SetGlobalSetting(new))), setting_in(), wallet_in()],
      [setting_out(new), lock_out(empty())],
      now,
      now + 10 * minute,
    ),
  )
}

// ADA fell: 73 ADA becomes 100.
test execute_a_new_pool_creation_fee() {
  execute_announced(
    GlobalSetting { ..setting(batcher), pool_creation_fee: 100000000 },
  )
}

test execute_no_pool_creation_fee() {
  execute_announced(GlobalSetting { ..setting(batcher), pool_creation_fee: 0 })
}

// Announced, waited for and signed by both keys, and still refused: the
// venue's opening fees would go somewhere other than the treasury.
test execute_a_pool_creation_fee_to_a_stranger() fail {
  execute_announced(
    GlobalSetting {
      ..setting(batcher),
      pool_creation_fee_receiver: wallet(stranger),
    },
  )
}

test minswap_would_take_a_pool_creation_fee_to_a_stranger() {
  minswap_admin_present(
    setting_tx(
      GlobalSetting {
        ..setting(batcher),
        pool_creation_fee_receiver: wallet(stranger),
      },
    ),
  )
}

// The treasury's payment script with another stake key is another address.
test execute_a_pool_creation_fee_to_the_treasury_restaked() fail {
  execute_announced(
    GlobalSetting {
      ..setting(batcher),
      pool_creation_fee_receiver: Address {
        ..treasury(),
        stake_credential: Some(Inline(VerificationKeyCredential(stranger))),
      },
    },
  )
}

test execute_a_negative_pool_creation_fee() fail {
  execute_announced(GlobalSetting { ..setting(batcher), pool_creation_fee: -1 })
}

// --- Withdraw the fee share -------------------------------------------------

fn paid(lovelace: Int, tokens: Int, to: Address) -> Output {
  Output {
    address: to,
    value: value.from_lovelace(lovelace)
      |> value.add(token_policy, token_name, tokens),
    datum: NoDatum,
    reference_script: None,
  }
}

fn withdraw_tx(to: Address) -> ScriptContext {
  spend_ctx(
    [lock_in(two()), pool_in(), wallet_in()],
    [
      pool_out(pool_datum(), pool_stake, pool_value(0, 0)),
      lock_out(two()),
      paid(earned_a, earned_b, to),
    ],
    now,
    now + 10 * minute,
  )
}

fn withdraw(ctx: ScriptContext) -> Bool {
  lock.spend(params(), two(), WithdrawFeeSharing, ctx)
}

test withdraw_to_the_treasury() {
  withdraw(withdraw_tx(treasury()))
}

test minswap_takes_the_withdrawal() {
  minswap_withdraws(withdraw_tx(treasury()))
}

test withdraw_to_a_stranger() fail {
  withdraw(withdraw_tx(wallet(stranger)))
}

test minswap_would_pay_a_stranger() {
  minswap_withdraws(withdraw_tx(wallet(stranger)))
}

test withdraw_one_lovelace_short() fail {
  withdraw(
    outputs(
      withdraw_tx(treasury()),
      [
        pool_out(pool_datum(), pool_stake, pool_value(0, 0)),
        lock_out(two()),
        paid(earned_a - 1, earned_b, treasury()),
        paid(1, 0, wallet(stranger)),
      ],
    ),
  )
}

test withdraw_one_token_short() fail {
  withdraw(
    outputs(
      withdraw_tx(treasury()),
      [
        pool_out(pool_datum(), pool_stake, pool_value(0, 0)),
        lock_out(two()),
        paid(earned_a, earned_b - 1, treasury()),
        paid(2000000, 1, wallet(stranger)),
      ],
    ),
  )
}

test withdraw_in_two_payments_to_the_treasury() {
  withdraw(
    outputs(
      withdraw_tx(treasury()),
      [
        pool_out(pool_datum(), pool_stake, pool_value(0, 0)),
        lock_out(two()),
        paid(earned_a, 0, treasury()),
        paid(2000000, earned_b, treasury()),
      ],
    ),
  )
}

test withdraw_with_a_fee_change() fail {
  withdraw(
    outputs(
      withdraw_tx(treasury()),
      [
        pool_out(other_share(), pool_stake, pool_value(0, 0)),
        lock_out(two()),
        paid(earned_a, earned_b, treasury()),
      ],
    ),
  )
}

test withdraw_with_a_stake_key_change() fail {
  withdraw(
    outputs(
      withdraw_tx(treasury()),
      [
        pool_out(pool_datum(), stranger, pool_value(0, 0)),
        lock_out(two()),
        paid(earned_a, earned_b, treasury()),
      ],
    ),
  )
}

test withdraw_changes_the_announcements() fail {
  withdraw(
    outputs(
      withdraw_tx(treasury()),
      [
        pool_out(pool_datum(), pool_stake, pool_value(0, 0)),
        lock_out(empty()),
        paid(earned_a, earned_b, treasury()),
      ],
    ),
  )
}

test withdraw_key_a_alone() fail {
  withdraw(signed(withdraw_tx(treasury()), [owner_a]))
}

test withdraw_while_moving_the_setting_too() fail {
  withdraw(
    outputs(
      inputs(
        withdraw_tx(treasury()),
        [lock_in(two()), pool_in(), setting_in(), wallet_in()],
      ),
      [
        pool_out(pool_datum(), pool_stake, pool_value(0, 0)),
        setting_out(setting(stranger)),
        lock_out(two()),
        paid(earned_a, earned_b, treasury()),
      ],
    ),
  )
}

test withdraw_while_changing_the_setting() fail {
  withdraw(
    outputs(
      inputs(
        withdraw_tx(treasury()),
        [lock_in(two()), setting_in(), wallet_in()],
      ),
      [setting_out(setting(stranger)), lock_out(two())],
    ),
  )
}

// --- Not the lock -----------------------------------------------------------

// Anyone can send a UTxO to the lock's address with any datum. One carrying
// an announcement nobody waited for must not make the change.
fn forged() -> State {
  State {
    announced: [
      Announcement {
        change: SetGlobalSetting(setting(stranger)),
        ready_at: now,
      },
    ],
  }
}

fn forged_tx() -> ScriptContext {
  spend_ctx(
    [
      Input {
        output_reference: utxo(0),
        output: Output {
          ..lock_out(forged()),
          value: value.from_lovelace(2000000),
        },
      },
      setting_in(),
      wallet_in(),
    ],
    [
      setting_out(setting(stranger)),
      Output { ..lock_out(empty()), value: value.from_lovelace(2000000) },
    ],
    now,
    now + 10 * minute,
  )
}

test execute_a_forged_history() fail {
  lock.spend(params(), forged(), Execute { index: 0 }, forged_tx())
}

fn copy_in() -> Input {
  Input {
    output_reference: utxo(5),
    output: Output { ..lock_out(two()), value: value.from_lovelace(2000000) },
  }
}

fn beside_the_lock() -> ScriptContext {
  inputs(
    withdraw_tx(treasury()),
    [copy_in(), lock_in(two()), pool_in(), wallet_in()],
  )
}

// A copy of the lock's datum beside the real lock, in a transaction the real
// lock accepts: only the token tells them apart.
test the_real_lock_beside_a_copy() {
  withdraw(beside_the_lock())
}

test spend_a_copy_without_the_token() fail {
  lock.spend(
    params(),
    two(),
    WithdrawFeeSharing,
    ScriptContext { ..beside_the_lock(), purpose: Spend(utxo(5)) },
  )
}

test minswap_would_count_it_as_the_admin() {
  minswap_admin_present(forged_tx())
}

// Two owner keys that are one key would be one signature.
test same_key_twice() fail {
  lock.spend(
    Params { ..params(), owner_b: owner_a },
    empty(),
    Announce { announcement: fee_on() },
    signed(announce_ctx(), [owner_a]),
  )
}
