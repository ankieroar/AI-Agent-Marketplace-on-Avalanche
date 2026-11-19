# Day 3 deployment manifests (Người 1)

This folder is the **hand-off contract** between the blockchain work and the web/backend work.
It contains only public information: contract addresses, public chain IDs and ABIs. It never
contains a private key, RPC secret or API token.

## Files written by `scripts/deploy-day3.js`

| File | Network | Purpose |
|---|---|---|
| `fuji.json` | Fuji C-Chain (EVM 43113) | Marketplace: `AgentRegistry`, `MerchantPolicyRegistry`, `SettlementEscrow`, `ServiceOrderManager`, `MarketplaceGateway`, `DisputeResultReceiver` |
| `dispute-l1.json` | Custom Dispute L1 (EVM 662831) | Dispute: `Verifier`, `ProofGate`, `DisputeManager`, `DisputeInbox`, `DisputeResultSender` |
| `abi/<Contract>.json` | — | Raw ABI array for each deployed contract, ready for viem/wagmi `parseAbi` or ethers |

Contract keys in the manifest are the **logical names** used by scripts and the web app.
`Verifier` is the Solidity verifier actually wired into `ProofGate`; it may be
`ServicePolicyUltraVerifier` (real Groth16/UltraHonk) or `MockServicePolicyVerifier` (local only).

## Schema

```jsonc
{
  "schema": "day3-deploy/v1",
  "role": "fuji",                  // or "dispute-l1"
  "network": "fuji",               // hardhat network name used to deploy
  "chainId": 43113,                // EVM chain ID (wallet)
  "blockchainId": "yH8D7…HWp",     // Avalanche blockchain ID (cb58, Teleporter routing)
  "blockchainIdBytes32": "0x7fc9…10d5",
  "teleporterMessenger": "0x253b…5fcf",
  "reviewer": "0x…",               // dispute-l1 only
  "deployer": "0x…",
  "generatedAt": "2026-11-19T…Z",
  "contracts": {
    "AgentRegistry": {
      "address": "0x…",
      "txHash": "0x…",
      "blockNumber": 123,
      "abi": "abi/AgentRegistry.json"
    }
  },
  "wiring": [
    { "label": "MarketplaceGateway.peer", "status": "sent", "txHash": "0x…", "at": "…" }
  ]
}
```

`wiring[].status` is `sent`, `already-set` or `planned` (dry run).

## Commands

```powershell
cd project/contracts

# 0. Check RPC, chain IDs, Teleporter messenger and blockchain IDs (no key needed)
node scripts/day3-preflight.js --read-only

# 1. Deploy the L1 side first (needs DAY3_REVIEWER set in project/.env)
npx.cmd hardhat run scripts/deploy-day3.js --network disputeL1

# 2. Deploy the Fuji side
npx.cmd hardhat run scripts/deploy-day3.js --network fuji

# 3. Finish/repair peer allowlists on both sides (idempotent)
node scripts/day3-configure.js

# 4. Read-only proof that everything is wired
node scripts/day3-verify.js
```

The deploy script is **resumable**: addresses already present in the manifest are reused when
they still have bytecode. Do not delete a manifest unless you intend to redeploy, because
`setPeer`, `setInbox`, `setOrderManager` and the reviewer are locked on-chain once set.

## Local rehearsal

`npm run demo:day3` (with `npx hardhat node` running) deploys the same stack against two
`V2MockMessenger` instances, writes manifests to `.runtime/day3/deployments/`, and runs the
buy → dispute → reject/approve → resolution flow with assertions. Verify the produced files:

```powershell
node scripts/day3-verify.js --dir .runtime/day3/deployments --local
node scripts/day3-configure.js --local   # idempotent; reports already-set wiring
```

## Security notes

- Never add `PRIVATE_KEY`, `OPENROUTER_API_KEY`, `DATABASE_URL` or `API_ACCESS_TOKEN` here.
- The manifest is safe to commit and share with the web/backend teammates.
- Rotate keys if a manifest accidentally contains anything other than the fields above.
