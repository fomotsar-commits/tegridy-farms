// ---------------------------------------------------------------------------
// Memetics: tests of the factory validator's Pool Creation, the pool creation
// fee above all. Not a module of its own: cardano/guards/prove-build.mjs
// appends this file to a staged copy of
// minswap-dex-v2/validators/factory_validator.ak and runs `aiken check` there,
// since Aiken v1.0.24 tests can call a validator only from its own module. The
// names it uses unqualified are that module's imports.
// Every refused case is a passing transaction with one thing changed.

const test_authen = #"20202020202020202020202020202020202020202020202020202020"

const test_factory = #"21212121212121212121212121212121212121212121212121212121"

const test_pool = #"30303030303030303030303030303030303030303030303030303030"

const test_batching =
  #"31313131313131313131313131313131313131313131313131313131"

const test_pool_stake =
  #"50505050505050505050505050505050505050505050505050505050"

const test_lock = #"10101010101010101010101010101010101010101010101010101010"

const test_batcher = #"61616161616161616161616161616161616161616161616161616161"

const test_treasury =
  #"70707070707070707070707070707070707070707070707070707070"

const test_opener = #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

const test_stranger =
  #"e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0"

const test_token_policy =
  #"40404040404040404040404040404040404040404040404040404040"

const test_token_name = #"544f4b"

/// 73 ADA, about $15 on 2026-10-25.
const test_fee = 73000000

/// The pool opens with 1,000 ADA and 5,000 TOK.
const test_amount_a = 1000000000

const test_amount_b = 5000000000

/// The factory's linked list before this pool: one node, its whole range.
const test_head = #"00"

const test_tail =
  #"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

fn test_ada() -> Asset {
  Asset { policy_id: ada_policy_id, asset_name: ada_asset_name }
}

fn test_tok() -> Asset {
  Asset { policy_id: test_token_policy, asset_name: test_token_name }
}

fn test_lp() -> ByteArray {
  utils.compute_lp_asset_name(
    ada_policy_id,
    ada_asset_name,
    test_token_policy,
    test_token_name,
  )
}

fn test_wallet(key: ByteArray) -> Address {
  Address {
    payment_credential: credential.VerificationKeyCredential(key),
    stake_credential: None,
  }
}

fn test_treasury_address() -> Address {
  Address {
    payment_credential: ScriptCredential(test_treasury),
    stake_credential: None,
  }
}

fn test_pool_address() -> Address {
  Address {
    payment_credential: ScriptCredential(test_pool),
    stake_credential: Some(
      credential.Inline(credential.VerificationKeyCredential(test_pool_stake)),
    ),
  }
}

fn test_batching_credential() -> StakeCredential {
  credential.Inline(ScriptCredential(test_batching))
}

fn test_ref(n: Int) -> transaction.OutputReference {
  transaction.OutputReference {
    transaction_id: transaction.TransactionId {
      hash: #"0303030303030303030303030303030303030303030303030303030303030303",
    },
    output_index: n,
  }
}

fn test_factory_out(head: ByteArray, tail: ByteArray) -> Output {
  Output {
    address: Address {
      payment_credential: ScriptCredential(test_factory),
      stake_credential: None,
    },
    value: value.from_lovelace(2000000)
      |> value.add(test_authen, utils.factory_auth_asset_name, 1),
    datum: transaction.InlineDatum(FactoryDatum { head, tail }),
    reference_script: None,
  }
}

fn test_opener_in() -> Input {
  Input {
    output_reference: test_ref(1),
    output: Output {
      address: test_wallet(test_opener),
      value: value.from_lovelace(2000000000)
        |> value.add(test_token_policy, test_token_name, test_amount_b),
      datum: transaction.NoDatum,
      reference_script: None,
    },
  }
}

/// Our GlobalSetting: every role the 48-hour lock, and the fee.
fn test_setting(fee: Int) -> types.GlobalSetting {
  types.GlobalSetting {
    batchers: [types.PAMSignature(test_batcher)],
    pool_fee_updater: types.PAMSpendScript(test_lock),
    fee_sharing_taker: types.PAMSpendScript(test_lock),
    pool_stake_key_updater: types.PAMSpendScript(test_lock),
    pool_dynamic_fee_updater: types.PAMSpendScript(test_lock),
    admin: types.PAMSpendScript(test_lock),
    pool_creation_fee: fee,
    pool_creation_fee_receiver: test_treasury_address(),
  }
}

/// Minswap's own GlobalSetting, which has no fee.
type MinswapGlobalSetting {
  batchers: List<types.PoolAuthorizationMethod>,
  pool_fee_updater: types.PoolAuthorizationMethod,
  fee_sharing_taker: types.PoolAuthorizationMethod,
  pool_stake_key_updater: types.PoolAuthorizationMethod,
  pool_dynamic_fee_updater: types.PoolAuthorizationMethod,
  admin: types.PoolAuthorizationMethod,
}

fn test_minswap_setting() -> MinswapGlobalSetting {
  MinswapGlobalSetting {
    batchers: [types.PAMSignature(test_batcher)],
    pool_fee_updater: types.PAMSpendScript(test_lock),
    fee_sharing_taker: types.PAMSpendScript(test_lock),
    pool_stake_key_updater: types.PAMSpendScript(test_lock),
    pool_dynamic_fee_updater: types.PAMSpendScript(test_lock),
    admin: types.PAMSpendScript(test_lock),
  }
}

/// The GlobalSetting UTxO: at the authen script, holding its one token.
fn test_setting_in(setting: Data) -> Input {
  Input {
    output_reference: test_ref(2),
    output: Output {
      address: Address {
        payment_credential: ScriptCredential(test_authen),
        stake_credential: None,
      },
      value: value.from_lovelace(2000000)
        |> value.add(test_authen, utils.global_setting_asset_name, 1),
      datum: transaction.InlineDatum(setting),
      reference_script: None,
    },
  }
}

fn test_liquidity() -> Int {
  math.calculate_initial_liquidity(test_amount_a, test_amount_b)
}

fn test_pool_out() -> Output {
  Output {
    address: test_pool_address(),
    value: value.from_lovelace(utils.min_pool_ada + test_amount_a)
      |> value.add(test_token_policy, test_token_name, test_amount_b)
      |> value.add(
           test_authen,
           test_lp(),
           9223372036854775807 - (
             test_liquidity() - utils.default_burn_liquidity
           ),
         )
      |> value.add(test_authen, utils.pool_auth_asset_name, 1),
    datum: transaction.InlineDatum(
      PoolDatum {
        pool_batching_stake_credential: test_batching_credential(),
        asset_a: test_ada(),
        asset_b: test_tok(),
        total_liquidity: test_liquidity(),
        reserve_a: test_amount_a,
        reserve_b: test_amount_b,
        base_fee_a_numerator: 30,
        base_fee_b_numerator: 30,
        fee_sharing_numerator_opt: None,
        allow_dynamic_fee: False,
      },
    ),
    reference_script: None,
  }
}

fn test_paid(lovelace: Int, to: Address) -> Output {
  Output {
    address: to,
    value: value.from_lovelace(lovelace),
    datum: transaction.NoDatum,
    reference_script: None,
  }
}

/// A pool opened for 1,000 ADA and 5,000 TOK, the setting referenced and
/// `fee_outputs` paid after the factory's two outputs and the pool.
fn test_opening(fee_outputs: List<Output>, setting: Data) -> ScriptContext {
  ScriptContext {
    transaction: Transaction {
      ..transaction.placeholder(),
      inputs: [
        Input {
          output_reference: test_ref(0),
          output: test_factory_out(test_head, test_tail),
        },
        test_opener_in(),
      ],
      reference_inputs: [test_setting_in(setting)],
      outputs: list.concat(
        [
          test_factory_out(test_head, test_lp()),
          test_factory_out(test_lp(), test_tail),
          test_pool_out(),
        ],
        fee_outputs,
      ),
      mint: value.to_minted_value(
        pool_validation.get_pool_creation_expected_mint(test_authen, test_lp()),
      ),
    },
    purpose: Spend(test_ref(0)),
  }
}

fn test_opens(ctx: ScriptContext) -> Bool {
  validate_factory(
    test_authen,
    test_pool_address(),
    test_batching_credential(),
    FactoryDatum { head: test_head, tail: test_tail },
    FactoryRedeemer { asset_a: test_ada(), asset_b: test_tok() },
    ctx,
  )
}

fn test_references(ctx: ScriptContext, refs: List<Input>) -> ScriptContext {
  ScriptContext {
    ..ctx,
    transaction: Transaction { ..ctx.transaction, reference_inputs: refs },
  }
}

// --- Opens ------------------------------------------------------------------

test opens_paying_the_fee() {
  test_opens(
    test_opening(
      [test_paid(test_fee, test_treasury_address())],
      test_setting(test_fee),
    ),
  )
}

test opens_paying_the_fee_in_two_outputs() {
  test_opens(
    test_opening(
      [
        test_paid(40000000, test_treasury_address()),
        test_paid(33000000, test_treasury_address()),
      ],
      test_setting(test_fee),
    ),
  )
}

// The fee re-set to nothing through the lock.
test opens_free_when_the_fee_is_zero() {
  test_opens(test_opening([], test_setting(0)))
}

// --- Refused: the fee ------------------------------------------------------

test opening_without_the_fee() fail {
  test_opens(test_opening([], test_setting(test_fee)))
}

test opening_a_lovelace_short() fail {
  test_opens(
    test_opening(
      [test_paid(test_fee - 1, test_treasury_address())],
      test_setting(test_fee),
    ),
  )
}

test opening_with_the_fee_paid_to_a_stranger() fail {
  test_opens(
    test_opening(
      [test_paid(test_fee, test_wallet(test_stranger))],
      test_setting(test_fee),
    ),
  )
}

// The treasury's payment script with another stake key is another address.
test opening_with_the_fee_paid_to_the_treasury_restaked() fail {
  test_opens(
    test_opening(
      [
        test_paid(
          test_fee,
          Address {
            ..test_treasury_address(),
            stake_credential: Some(
              credential.Inline(
                credential.VerificationKeyCredential(test_stranger),
              ),
            ),
          },
        ),
      ],
      test_setting(test_fee),
    ),
  )
}

// Only lovelace counts: 73,000,000 TOK beside the UTxO's 2 ADA is not 73 ADA.
test opening_with_the_fee_paid_in_tokens() fail {
  test_opens(
    test_opening(
      [
        Output {
          ..test_paid(2000000, test_treasury_address()),
          value: value.from_lovelace(2000000)
            |> value.add(test_token_policy, test_token_name, test_fee),
        },
      ],
      test_setting(test_fee),
    ),
  )
}

// --- Refused: the setting that names the fee ---------------------------------

test opening_without_the_setting() fail {
  test_opens(
    test_references(
      test_opening(
        [test_paid(test_fee, test_treasury_address())],
        test_setting(test_fee),
      ),
      [],
    ),
  )
}

// A setting of the opener's own that says the fee is 0, without the token.
test opening_against_a_setting_without_its_token() fail {
  test_opens(
    test_references(
      test_opening([], test_setting(0)),
      [
        Input {
          ..test_setting_in(test_setting(0)),
          output: Output {
            ..test_setting_in(test_setting(0)).output,
            value: value.from_lovelace(2000000),
          },
        },
      ],
    ),
  )
}

// The setting spent instead of referenced is not read.
test opening_with_the_setting_spent() fail {
  let ctx =
    test_opening(
      [test_paid(test_fee, test_treasury_address())],
      test_setting(test_fee),
    )
  test_opens(
    ScriptContext {
      ..ctx,
      transaction: Transaction {
        ..ctx.transaction,
        inputs: list.concat(
          ctx.transaction.inputs,
          [test_setting_in(test_setting(test_fee))],
        ),
        reference_inputs: [],
      },
    },
  )
}

// Minswap's own shape, without the two fields, is not read as "no fee".
test opening_against_minswaps_setting() fail {
  test_opens(test_opening([], test_minswap_setting()))
}

// --- The datum's layout, for the code that writes it ------------------------

// The two fields come after Minswap's six, so each of those keeps its index.
test the_fee_fields_come_last() {
  let setting: Data = test_setting(test_fee)
  let receiver: Data = test_treasury_address()
  let minswap: Data = test_minswap_setting()
  let (index, fields) = builtin.un_constr_data(setting)
  let (minswap_index, minswap_fields) = builtin.un_constr_data(minswap)
  and {
    index == minswap_index,
    list.take(fields, 6) == minswap_fields,
    list.drop(fields, 6) == [builtin.i_data(test_fee), receiver],
  }
}
