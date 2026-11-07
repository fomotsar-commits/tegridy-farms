//// Minswap V2 checks a `PAMSpendScript` role by finding any input at the
//// script, so spending the lock authorises every role it holds at once. Each
//// path therefore states which pool or GlobalSetting the transaction may
//// move and what it must leave there. Times are Compound's Timelock: 48 hours
//// of notice, then a 14-day window.

use aiken/dict
use aiken/hash.{Blake2b_224, Hash}
use aiken/interval.{Finite}
use aiken/list
use aiken/transaction.{
  InlineDatum, Input, Mint, Output, ScriptContext, Spend, Transaction,
  ValidityRange,
}
use aiken/transaction/credential.{Address, ScriptCredential, VerificationKey}
use aiken/transaction/value.{AssetName, PolicyId, Value}
use amm_dex_v2/types.{PoolDatum} as minswap
use amm_dex_v2/utils.{global_setting_asset_name, pool_auth_asset_name}
use role_timelock/types.{
  Action, Announce, Announcement, Cancel, Change, Execute, Params,
  SetGlobalSetting, SetPool, State, WithdrawFeeSharing,
}

/// 48 hours, in milliseconds.
pub const delay = 172800000

/// 14 days, in milliseconds.
pub const grace = 1209600000

/// Keeps every transaction that spends the lock well inside the limits.
pub const max_announced = 16

/// "role-timelock"
pub const lock_token_name = #"726f6c652d74696d656c6f636b"

/// The lock token is minted once, into the lock, with nothing announced.
pub fn mint(params: Params, ctx: ScriptContext) -> Bool {
  expect Mint(own) = ctx.purpose
  let Transaction { inputs, outputs, mint, extra_signatories, .. } =
    ctx.transaction
  and {
    list.any(inputs, fn(i) { i.output_reference == params.seed }),
    dict.to_list(value.tokens(value.from_minted_value(mint), own)) == [
      (lock_token_name, 1),
    ],
    both_signed(params, extra_signatories),
    locks_into(outputs, own, State { announced: [] }),
  }
}

pub fn spend(
  params: Params,
  state: State,
  action: Action,
  ctx: ScriptContext,
) -> Bool {
  expect Spend(own_ref) = ctx.purpose
  let Transaction { inputs, outputs, extra_signatories, validity_range, .. } =
    ctx.transaction
  expect Some(Input { output: own_input, .. }) =
    transaction.find_input(inputs, own_ref)
  expect ScriptCredential(own) = own_input.address.payment_credential
  // Only the UTxO holding the lock token is the lock. Anything else sent to
  // this address can never be spent.
  expect holds(own_input.value, own, lock_token_name)
  let moved = list.filter(inputs, fn(i) { or {
          holds(i.output.value, params.authen_policy_id, pool_auth_asset_name),
          holds(
            i.output.value,
            params.authen_policy_id,
            global_setting_asset_name,
          ),
        } })
  and {
    both_signed(params, extra_signatories),
    when action is {
      Announce { announcement } -> and {
          moved == [],
          announcement.ready_at >= upper_bound(validity_range) + delay,
          list.length(state.announced) < max_announced,
          locks_into(
            outputs,
            own,
            State { announced: list.concat(state.announced, [announcement]) },
          ),
        }
      Cancel { index } -> and {
          moved == [],
          index >= 0,
          index < list.length(state.announced),
          locks_into(
            outputs,
            own,
            State { announced: remove(state.announced, index) },
          ),
        }
      Execute { index } -> {
        expect Some(Announcement { change, ready_at }) =
          list.at(state.announced, index)
        and {
          lower_bound(validity_range) >= ready_at,
          upper_bound(validity_range) <= ready_at + grace,
          locks_into(
            outputs,
            own,
            State { announced: remove(state.announced, index) },
          ),
          makes(change, moved, outputs, params.authen_policy_id),
        }
      }
      WithdrawFeeSharing -> and {
          locks_into(outputs, own, state),
          pays_treasury(moved, outputs, params),
        }
    },
  }
}

/// The transaction moves one UTxO and leaves it as announced. The checks fail
/// unless that UTxO is the one changed: the GlobalSetting token exists once,
/// and a pool keeps its value here and its address in `pays_treasury`.
fn makes(
  change: Change,
  moved: List<Input>,
  outputs: List<Output>,
  authen: PolicyId,
) -> Bool {
  when change is {
    SetGlobalSetting { setting } -> {
      expect [_] = moved
      expect [setting_out] =
        list.filter(
          outputs,
          fn(o) { holds(o.value, authen, global_setting_asset_name) },
        )
      let expected: Data = setting
      setting_out.datum == InlineDatum(expected)
    }
    SetPool {
      asset_a,
      asset_b,
      base_fee_a_numerator,
      base_fee_b_numerator,
      fee_sharing_numerator_opt,
      allow_dynamic_fee,
      stake_credential,
    } -> {
      expect [pool_in] = moved
      expect [pool_out] =
        list.filter(
          outputs,
          fn(o) { holds(o.value, authen, pool_auth_asset_name) },
        )
      expect InlineDatum(raw) = pool_out.datum
      expect after: PoolDatum = raw
      and {
        // A fee-sharing withdrawal goes only to the treasury, below.
        pool_out.value == pool_in.output.value,
        pool_out.address.stake_credential == stake_credential,
        after.asset_a == asset_a,
        after.asset_b == asset_b,
        after.base_fee_a_numerator == base_fee_a_numerator,
        after.base_fee_b_numerator == base_fee_b_numerator,
        after.fee_sharing_numerator_opt == fee_sharing_numerator_opt,
        after.allow_dynamic_fee == allow_dynamic_fee,
      }
    }
  }
}

/// One pool, its address and datum unchanged, and the treasury receives at
/// least everything that left it.
fn pays_treasury(
  moved: List<Input>,
  outputs: List<Output>,
  params: Params,
) -> Bool {
  let authen = params.authen_policy_id
  expect [pool_in] = moved
  expect [pool_out] =
    list.filter(outputs, fn(o) { holds(o.value, authen, pool_auth_asset_name) })
  let taken = value.merge(pool_in.output.value, value.negate(pool_out.value))
  let paid =
    list.foldl(
      outputs,
      value.zero(),
      fn(o, sum) {
        if o.address == params.treasury {
          value.merge(sum, o.value)
        } else {
          sum
        }
      },
    )
  and {
    pool_out.address == pool_in.output.address,
    pool_out.datum == pool_in.output.datum,
    list.all(
      value.flatten(taken),
      fn(asset) {
        let (policy, name, quantity) = asset
        value.quantity_of(paid, policy, name) >= quantity
      },
    ),
  }
}

/// The one output holding the lock token is the lock, carrying `state`.
fn locks_into(outputs: List<Output>, own: PolicyId, state: State) -> Bool {
  let expected: Data = state
  when list.filter(outputs, fn(o) { holds(o.value, own, lock_token_name) }) is {
    [lock] -> and {
        lock.address == Address {
          payment_credential: ScriptCredential(own),
          stake_credential: None,
        },
        value.without_lovelace(lock.value) == value.from_asset(
          own,
          lock_token_name,
          1,
        ),
        lock.datum == InlineDatum(expected),
        lock.reference_script == None,
      }
    _ -> False
  }
}

fn both_signed(
  params: Params,
  signatories: List<Hash<Blake2b_224, VerificationKey>>,
) -> Bool {
  and {
    params.owner_a != params.owner_b,
    list.has(signatories, params.owner_a),
    list.has(signatories, params.owner_b),
  }
}

fn holds(v: Value, policy: PolicyId, name: AssetName) -> Bool {
  value.quantity_of(v, policy, name) > 0
}

pub fn remove(self: List<a>, index: Int) -> List<a> {
  list.concat(list.take(self, index), list.drop(self, index + 1))
}

// A transaction's time is somewhere in its validity range; both ends must be
// set. Whether an end is inclusive moves it by a millisecond, and no check
// here is that close.
fn lower_bound(range: ValidityRange) -> Int {
  expect Finite(t) = range.lower_bound.bound_type
  t
}

fn upper_bound(range: ValidityRange) -> Int {
  expect Finite(t) = range.upper_bound.bound_type
  t
}
