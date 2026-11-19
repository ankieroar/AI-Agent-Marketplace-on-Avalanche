// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../v2/CrossChainEndpoint.sol";

/// Delivers synchronously on Fuji. Receivers authenticate both this contract and the original sender.
contract FujiDisputeMessenger is IV2Messenger {
    bytes32 public immutable blockchainID;
    uint256 private sequence;
    event Delivered(bytes32 indexed messageId, address indexed sender, address indexed receiver);

    constructor(bytes32 domain) {
        require(domain != bytes32(0), "Missing domain");
        blockchainID = domain;
    }

    function sendCrossChainMessage(V2MessageInput calldata input) external returns (bytes32 id) {
        require(input.destinationBlockchainID == blockchainID, "Wrong domain");
        require(input.destinationAddress.code.length != 0, "Unknown receiver");
        require(input.feeInfo.amount == 0 && input.allowedRelayerAddresses.length == 0, "Unsupported relay options");
        id = keccak256(abi.encode(block.chainid, address(this), ++sequence, msg.sender, input.destinationAddress, input.message));
        IV2Receiver(input.destinationAddress).receiveTeleporterMessage(blockchainID, msg.sender, input.message);
        emit Delivered(id, msg.sender, input.destinationAddress);
    }
}
