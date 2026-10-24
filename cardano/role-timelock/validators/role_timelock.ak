use aiken/transaction.{ScriptContext}
use role_timelock/lock
use role_timelock/types.{Action, Params, State}

// One script hash for both: the lock token's policy id is the lock's own
// payment credential, as with Minswap's GlobalSetting.
validator(params: Params) {
  fn mint(_redeemer: Data, ctx: ScriptContext) {
    lock.mint(params, ctx)
  }

  fn spend(state: State, action: Action, ctx: ScriptContext) {
    lock.spend(params, state, action, ctx)
  }
}
