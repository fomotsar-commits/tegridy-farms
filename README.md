# Tegridy Farms

Art-first yield farming protocol on Ethereum. 100% of swap fees go to TOWELI stakers.

## Architecture

- `frontend/` — React 19 + Vite + Tailwind CSS + wagmi/viem
- `contracts/` — Solidity 0.8.26 + Foundry (forge)
- `indexer/` — Ponder GraphQL indexer

## Quick Start

### Frontend
```bash
cd frontend
cp .env.example .env  # Fill in API keys
npm install
npm run dev
```

### Contracts
```bash
cd contracts
cp .env.example .env  # Fill in keys
forge install
forge build
forge test
```

## Deployed Contracts (Ethereum Mainnet)

| Contract | Address |
|----------|---------|
| TegridyLending | 0xd471e5675EaDbD8C192A5dA2fF44372D5713367f |
| TegridyNFTLending | 0x63baD13f89186E0769F636D4Cd736eB26E2968aD |
| TegridyNFTPoolFactory | 0x1C0e1771943fbB299f4E19daD0fAA4Fa4e6c04f0 |

## Security

See [Security Page](https://tegridyfarms.xyz/security) for audit methodology, tracked fixes, and bug bounty.

## License

MIT
