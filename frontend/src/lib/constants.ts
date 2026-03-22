// TOWELI Token
export const TOWELI_ADDRESS = '0x420698cfdeddea6bc78d59bc17798113ad278f9d' as const;

// Contracts - DEPLOYED ON MAINNET
export const TEGRIDY_FARM_ADDRESS = '0xAA8aD310e541F4bB89C44Ad7faba74F8B4027f2f' as const;
export const FEE_DISTRIBUTOR_ADDRESS = '0xEfefc0FA229ee0415B803Fa1352cE6aBbe316240' as const;

// Uniswap V2 TOWELI/WETH LP Token (verified on mainnet)
export const TOWELI_WETH_LP_ADDRESS = '0x6682ac593513cc0a6c25d0f3588e8fa4ff81104d' as const;

// Uniswap V2
export const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' as const;
export const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;
export const UNISWAP_V2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f' as const;

// Chainlink ETH/USD Price Feed
export const ETH_USD_FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as const;

// Pool IDs
export const LP_POOL_ID = 0n;
export const TOWELI_POOL_ID = 1n;

// Chain
export const CHAIN_ID = 1; // Ethereum Mainnet

// Token info
export const TOWELI_DECIMALS = 18;
export const TOWELI_TOTAL_SUPPLY = 420_690_000_000_000; // 420.69T
export const INITIAL_REWARDS_FUND = 26_000_000; // 26M TOWELI

// Helper: check if an address is deployed (not zero address)
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export function isDeployed(address: string): boolean {
  return address !== ZERO_ADDRESS;
}

// External links
export const ETHERSCAN_TOKEN = `https://etherscan.io/token/${TOWELI_ADDRESS}`;
export const UNISWAP_BUY_URL = `https://app.uniswap.org/swap?outputCurrency=${TOWELI_ADDRESS}&chain=ethereum`;
export const GECKOTERMINAL_URL = `https://www.geckoterminal.com/eth/pools/${TOWELI_WETH_LP_ADDRESS}`;
export const GECKOTERMINAL_EMBED = `https://www.geckoterminal.com/eth/pools/${TOWELI_WETH_LP_ADDRESS}?embed=1&info=0&swaps=0&light_chart=0`;
// Keep for backwards compat in external links
export const DEXSCREENER_URL = `https://dexscreener.com/ethereum/${TOWELI_ADDRESS}`;
