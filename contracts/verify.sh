#!/bin/bash
# Verify all 9 deployed contracts on Etherscan
set -e

FORGE="$HOME/.foundry/bin/forge"
ETHERSCAN_KEY="${ETHERSCAN_API_KEY:?Set ETHERSCAN_API_KEY env var}"
RPC="https://ethereum-rpc.publicnode.com"
CHAIN="mainnet"

# Constructor args (from deployment)
TOWELI="0x420698CFdEDdEa6bc78D59bC17798113ad278F9D"
WETH="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
JBAC="0xd37264c71e9af940e49795F0d3a8336afAaFDdA9"
TREASURY="0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e"
UNISWAP_ROUTER="0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"
LP_TOKEN="0x6682ac593513cc0a6c25d0f3588e8fa4ff81104d"
REWARD_RATE="824300000000000000"
SWAP_FEE_BPS="30"
REFERRAL_FEE_BPS="1000"
MONTHLY_FEE="10000000000000000000000"

# New contract addresses
STAKING="0x626644523d34B84818df602c991B4a06789C4819"
RESTAKING="0xfE2E5B534cfc3b35773aA26A73beF16B028B0268"
REFERRAL="0x2ADe96633Ee51400E60De00f098280f07b92b060"
SWAP_ROUTER="0xd8f13c7F3e0C4139D1905914a99F2E9F77A4aD37"
GRANTS="0xEb00Fb134699634215ebF5Ea3a4D6FF3872a5B34"
REV_DIST="0xf00964D5F5fB0a4d4AFEa0999843DA31BbE9A7aF"
BOUNTY="0xAd9b32272376774d18F386A7676Bd06D7E33c647"
PREMIUM="0x514553EAcfCb91E05Db0a5e9B09d69d7e9CBaf20"
POL="0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca"

echo "=== Verifying 9 contracts on Etherscan ==="
echo ""

echo "1/9 TegridyStaking..."
$FORGE verify-contract $STAKING src/TegridyStaking.sol:TegridyStaking \
  --etherscan-api-key $ETHERSCAN_KEY \
  --rpc-url $RPC \
  --constructor-args $($HOME/.foundry/bin/cast abi-encode "constructor(address,address,address,uint256)" $TOWELI $JBAC $TREASURY $REWARD_RATE) \
  --chain $CHAIN --watch 2>&1 | tail -3

echo "2/9 TegridyRestaking..."
$FORGE verify-contract $RESTAKING src/TegridyRestaking.sol:TegridyRestaking \
  --etherscan-api-key $ETHERSCAN_KEY \
  --rpc-url $RPC \
  --constructor-args $($HOME/.foundry/bin/cast abi-encode "constructor(address,address,address,uint256)" $STAKING $TOWELI $WETH 0) \
  --chain $CHAIN --watch 2>&1 | tail -3

echo "3/9 ReferralSplitter..."
$FORGE verify-contract $REFERRAL src/ReferralSplitter.sol:ReferralSplitter \
  --etherscan-api-key $ETHERSCAN_KEY \
  --rpc-url $RPC \
  --constructor-args $($HOME/.foundry/bin/cast abi-encode "constructor(uint256,address,address,address)" $REFERRAL_FEE_BPS $STAKING $TREASURY $WETH) \
  --chain $CHAIN --watch 2>&1 | tail -3

echo "4/9 SwapFeeRouter..."
$FORGE verify-contract $SWAP_ROUTER src/SwapFeeRouter.sol:SwapFeeRouter \
  --etherscan-api-key $ETHERSCAN_KEY \
  --rpc-url $RPC \
  --constructor-args $($HOME/.foundry/bin/cast abi-encode "constructor(address,address,uint256,address)" $UNISWAP_ROUTER $TREASURY $SWAP_FEE_BPS $REFERRAL) \
  --chain $CHAIN --watch 2>&1 | tail -3

echo "5/9 CommunityGrants..."
$FORGE verify-contract $GRANTS src/CommunityGrants.sol:CommunityGrants \
  --etherscan-api-key $ETHERSCAN_KEY \
  --rpc-url $RPC \
  --constructor-args $($HOME/.foundry/bin/cast abi-encode "constructor(address,address,address,address)" $STAKING $TOWELI $TREASURY $WETH) \
  --chain $CHAIN --watch 2>&1 | tail -3

echo "6/9 RevenueDistributor..."
$FORGE verify-contract $REV_DIST src/RevenueDistributor.sol:RevenueDistributor \
  --etherscan-api-key $ETHERSCAN_KEY \
  --rpc-url $RPC \
  --constructor-args $($HOME/.foundry/bin/cast abi-encode "constructor(address,address,address)" $STAKING $TREASURY $WETH) \
  --chain $CHAIN --watch 2>&1 | tail -3

echo "7/9 MemeBountyBoard..."
$FORGE verify-contract $BOUNTY src/MemeBountyBoard.sol:MemeBountyBoard \
  --etherscan-api-key $ETHERSCAN_KEY \
  --rpc-url $RPC \
  --constructor-args $($HOME/.foundry/bin/cast abi-encode "constructor(address,address,address)" $TOWELI $STAKING $WETH) \
  --chain $CHAIN --watch 2>&1 | tail -3

echo "8/9 PremiumAccess..."
$FORGE verify-contract $PREMIUM src/PremiumAccess.sol:PremiumAccess \
  --etherscan-api-key $ETHERSCAN_KEY \
  --rpc-url $RPC \
  --constructor-args $($HOME/.foundry/bin/cast abi-encode "constructor(address,address,address,uint256)" $TOWELI $JBAC $TREASURY $MONTHLY_FEE) \
  --chain $CHAIN --watch 2>&1 | tail -3

echo "9/9 POLAccumulator..."
$FORGE verify-contract $POL src/POLAccumulator.sol:POLAccumulator \
  --etherscan-api-key $ETHERSCAN_KEY \
  --rpc-url $RPC \
  --constructor-args $($HOME/.foundry/bin/cast abi-encode "constructor(address,address,address,address)" $TOWELI $UNISWAP_ROUTER $LP_TOKEN $TREASURY) \
  --chain $CHAIN --watch 2>&1 | tail -3

echo ""
echo "=== Verification complete ==="
