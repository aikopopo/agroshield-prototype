require("@nomicfoundation/hardhat-toolbox");

// Educational project: only the built-in local Hardhat network is used.
// Do NOT add real networks, private keys or RPC URLs here.
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
};