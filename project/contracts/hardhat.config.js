require("@nomicfoundation/hardhat-toolbox");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const privateKey = process.env.PRIVATE_KEY;
const remoteAccounts = privateKey ? [privateKey.startsWith("0x") ? privateKey : "0x" + privateKey] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
    },
  },
  networks: {
    localhost: {
      url: process.env.DAY2_RPC_URL || "http://127.0.0.1:8545",
      chainId: 31337,
    },
    fuji: {
      url: process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc",
      chainId: 43113,
      accounts: remoteAccounts,
    },
    disputeL1: {
      url: process.env.DISPUTE_L1_RPC_URL || "https://managed-nodes.avax.network/ext/bc/CnnZk7teddWLgqy2BD74T6TDUD6oJJVR3DtZTAspXSDd2xCvz/rpc",
      chainId: 662831,
      accounts: remoteAccounts,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
