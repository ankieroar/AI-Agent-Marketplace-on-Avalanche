// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract MockServicePolicyVerifier {
    function verify(bytes calldata proof, bytes32[] calldata inputs) external pure returns (bool) {
        // Local fixture: anyone can construct this value. It is not a ZK proof.
        return keccak256(proof) == keccak256(abi.encode(inputs));
    }
}
