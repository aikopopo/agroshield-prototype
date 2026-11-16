Educational project for the course Introduction to Finance. Not a real product, service or investment offer. Do not use with real funds.

# AgroShield PolicyPool prototype

## What it does
PolicyPool is a smart contract for rainfall-index (parametric) crop insurance. An insurer funds a pool, farmers buy policies, two independent data providers report season rainfall, and if the recorded rainfall is below the threshold every policyholder is paid automatically. If the two readings disagree, or someone disputes a result, the payout is frozen until the regulator decides.

The prototype runs only on the local Hardhat network with test accounts. Money in the demo is the local test coin.

## How to run
Requirements: Node.js 22 (LTS).

```bash
npm install
npx hardhat compile
npx hardhat test
npx hardhat run scripts/demo.js
```

`npx hardhat test` runs 13 unit tests. `scripts/demo.js` runs the full scenario: deploy, grant roles, create a template, fund the pool, buy two policies, report rainfall, pay out, close the season.

## Roles
| Role | What it can do |
|---|---|
| Admin | Grants and revokes roles only. Cannot move funds or change results |
| Insurer | Creates templates, funds the pool, closes the season |
| Data provider | Submits rainfall readings (two different providers are required) |
| Regulator | Resolves disputes |
| Farmer (anyone) | Buys a policy, can call the payout evaluation |

## Security
- Reentrancy: `nonReentrant` guard and checks-effects-interactions (state is updated before money is sent). A test with a malicious contract checks this.
- Access control: role-based permissions (OpenZeppelin AccessControl), tested.
- Solvency: a policy can only be sold if the pool covers all payouts.
- No double payout: a season can be evaluated only once.
- A receiver that rejects a payment cannot block the others (pull-payment fallback).

Known limitations: a dispute that the regulator never resolves would freeze the season (a timeout is not implemented); the prototype uses a native test coin, not a stablecoin; data providers are trusted roles.

## Demo video
(https://drive.google.com/drive/folders/1hv63BJY2gKPwLQdKE24cQ_DrwHb2VE4v?usp=drive_link)

## Credits and AI use
Built with OpenZeppelin Contracts (MIT licence).
<write here exactly which parts were written with AI help, which tool and model, and what the team reviewed and changed>
