// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title ITeleporterReceiver
 * @notice Standard interface for receiving messages via Teleporter
 */
interface ITeleporterReceiver {
    function receiveTeleporterMessage(
        bytes32 originBlockchainID,
        address originSenderAddress,
        bytes calldata message
    ) external;
}

/**
 * @title PongReceiver
 * @notice Deployed on Dispute L1 to receive cross-chain messages from Fuji C-Chain.
 * Supports official TeleporterMessenger as well as authorized fallback relayer for hackathon resilience.
 */
contract PongReceiver is ITeleporterReceiver {
    // Official TeleporterMessenger on Avalanche Fuji & L1s
    address public constant TELEPORTER_MESSENGER = 0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf;

    // Avalanche Fuji C-Chain Blockchain ID
    bytes32 public constant FUJI_C_CHAIN_ID = 0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5;

    address public owner;
    address public relayer;

    event PongReceived(
        bytes32 indexed originBlockchainID,
        address indexed originSenderAddress,
        address indexed initialCaller,
        string messageText,
        uint256 sentTimestamp,
        uint256 receivedTimestamp
    );

    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);

    address public lastCaller;
    string public lastMessage;
    uint256 public totalReceivedMessages;

    modifier onlyAuthorized() {
        require(
            msg.sender == TELEPORTER_MESSENGER || msg.sender == relayer || msg.sender == owner,
            "PongReceiver: Unauthorized caller"
        );
        _;
    }

    constructor() {
        owner = msg.sender;
        relayer = msg.sender;
    }

    function setRelayer(address _relayer) external {
        require(msg.sender == owner, "Only owner");
        emit RelayerUpdated(relayer, _relayer);
        relayer = _relayer;
    }

    function receiveTeleporterMessage(
        bytes32 originBlockchainID,
        address originSenderAddress,
        bytes calldata message
    ) external override onlyAuthorized {
        (address caller, string memory text, uint256 sentTime) = abi.decode(message, (address, string, uint256));

        lastCaller = caller;
        lastMessage = text;
        totalReceivedMessages += 1;

        emit PongReceived(
            originBlockchainID,
            originSenderAddress,
            caller,
            text,
            sentTime,
            block.timestamp
        );
    }
}
