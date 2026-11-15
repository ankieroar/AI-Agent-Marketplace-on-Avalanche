// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

struct TeleporterFeeInfo {
    address feeTokenAddress;
    uint256 amount;
}

struct TeleporterMessageInput {
    bytes32 destinationBlockchainID;
    address destinationAddress;
    TeleporterFeeInfo feeInfo;
    uint256 requiredGasLimit;
    address[] allowedRelayerAddresses;
    bytes message;
}

interface ITeleporterMessenger {
    function sendCrossChainMessage(
        TeleporterMessageInput calldata messageInput
    ) external returns (uint256 messageID);
}

contract PingSender {
    address public constant TELEPORTER_MESSENGER = 0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf;

    event PingSent(
        bytes32 indexed destinationBlockchainID,
        address indexed destinationAddress,
        uint256 indexed messageID,
        string messageText,
        uint256 timestamp
    );

    function sendPing(
        bytes32 destinationBlockchainID,
        address destinationAddress,
        string calldata messageText
    ) external returns (uint256) {
        bytes memory payload = abi.encode(msg.sender, messageText, block.timestamp);

        address[] memory allowedRelayers = new address[](0);

        TeleporterMessageInput memory input = TeleporterMessageInput({
            destinationBlockchainID: destinationBlockchainID,
            destinationAddress: destinationAddress,
            feeInfo: TeleporterFeeInfo({
                feeTokenAddress: address(0),
                amount: 0
            }),
            requiredGasLimit: 250000,
            allowedRelayerAddresses: allowedRelayers,
            message: payload
        });

        uint256 messageID = ITeleporterMessenger(TELEPORTER_MESSENGER).sendCrossChainMessage(input);

        emit PingSent(destinationBlockchainID, destinationAddress, messageID, messageText, block.timestamp);
        return messageID;
    }
}
