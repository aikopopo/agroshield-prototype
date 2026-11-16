Educational project for the course Introduction to Finance. Not a real product, service or investment offer. Do not use with real funds.

# AgroShield PolicyPool prototype
(the rest is filled in at Step 12)

## What it does
PolicyPool is a smart contract for rainfall-index crop insurance. An insurer funds a pool,
farmers buy policies, two independent data providers report rainfall after the season, and if
rainfall is below the threshold every policyholder is paid automatically. A dispute mechanism
freezes payouts when the readings disagree.

## How to run
1. Install Node.js (LTS) and run `npm install`
2. `npx hardhat compile`
3. `npx hardhat test` (13 tests)
4. Demo: `npx hardhat node` in one terminal, then `npx hardhat run scripts/demo.js --network localhost`

Runs only on the local Hardhat network with test accounts.

## Roles
- Admin: grants roles only
- Insurer: creates templates, funds the pool, closes the season
- Data provider: submits rainfall readings (two different providers are required)
- Regulator: resolves disputes

## Security
Reentrancy (nonReentrant and checks-effects-interactions), access control (roles),
payout cannot be repeated, pool must cover every policy sold.

## Demo video
<paste the link here>

## Credits and AI use
Built with OpenZeppelin Contracts (MIT licence). <write here exactly which parts of the code were
written with AI help and which AI tool and model was used>