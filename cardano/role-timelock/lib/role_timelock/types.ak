use aiken/hash.{Blake2b_224, Hash}
use aiken/time.{PosixTime}
use aiken/transaction.{OutputReference}
use aiken/transaction/credential.{Address, StakeCredential, VerificationKey}
use aiken/transaction/value.{PolicyId}
use amm_dex_v2/types.{Asset, GlobalSetting}

/// Fixed at deploy. Changing any of them is a new lock, which is itself a
/// 48-hour change: the GlobalSetting naming the new lock's hash.
pub type Params {
  /// Spent by the one transaction that mints the lock token.
  seed: OutputReference,
  /// The two owner keys. Every spend of the lock needs both signatures.
  owner_a: Hash<Blake2b_224, VerificationKey>,
  owner_b: Hash<Blake2b_224, VerificationKey>,
  /// The only address a fee-sharing withdrawal may pay, and the only pool
  /// creation fee receiver a GlobalSetting change may name.
  treasury: Address,
  /// Our Minswap deploy's authen policy: its pool and GlobalSetting tokens
  /// mark the UTxOs Minswap's roles can change.
  authen_policy_id: PolicyId,
}

/// A change Minswap lets its roles make, stated as the state it leaves.
pub type Change {
  /// The GlobalSetting UTxO's new datum, exactly.
  SetGlobalSetting { setting: GlobalSetting }
  /// The parameters of the pool trading `asset_a` for `asset_b`, exactly.
  SetPool {
    asset_a: Asset,
    asset_b: Asset,
    base_fee_a_numerator: Int,
    base_fee_b_numerator: Int,
    fee_sharing_numerator_opt: Option<Int>,
    allow_dynamic_fee: Bool,
    stake_credential: Option<StakeCredential>,
  }
}

pub type Announcement {
  change: Change,
  /// The earliest time the change can be made. It stays possible for 14 days.
  ready_at: PosixTime,
}

/// The lock UTxO's datum.
pub type State {
  announced: List<Announcement>,
}

pub type Action {
  /// Adds an announcement, ready no sooner than 48 hours after the
  /// transaction's latest possible time.
  Announce { announcement: Announcement }
  /// Removes an announcement unmade.
  Cancel { index: Int }
  /// Makes an announced change in its window, and removes it.
  Execute { index: Int }
  /// Takes one pool's earned fee share to the treasury. Changes nothing.
  WithdrawFeeSharing
}
