# Shared schema v1

Canonical definitions: `packages/schema/index.mjs`. All uint256 values use decimal strings in JSON (never JavaScript floating point); timestamps use Unix seconds, payout uses smallest native-token units. IDs and hashes use 32-byte hex strings.

`policyCommitment = keccak256(abi.encode("warranty.policy.v1", purchaseTimestamp:uint256, warrantyEndTimestamp:uint256, maxPayout:uint256, nonce:bytes32))`. Generate nonce with a cryptographically secure RNG; keep it and policy terms private. Commitment must be recorded at purchase time by later core contracts. This is a schema agreement, not the production Noir policy circuit. The hello-world circuit does not verify this commitment.

CaseOpened JSON: `{version:1,caseId,policyCommitment,claimTimestamp,policyVersionHash,sourceBlockchainId,nonce}`. On-chain ABI encoding will use the same order, version as uint8, timestamps/nonce as uint256, remaining fields bytes32. The receiver must validate authenticated source chain/sender separately; never trust sourceBlockchainId inside payload alone. claimTimestamp must originate from block.timestamp in the future gateway, not AI/user input.

AI outputs are schema checked and never authorize payment. Unknown evidence must remain null/missing. ZK input derivation and eligibility remain deterministic prover/core-contract responsibilities. No LLM result is a proof.
