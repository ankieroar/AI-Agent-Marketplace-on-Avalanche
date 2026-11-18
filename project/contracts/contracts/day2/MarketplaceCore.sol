// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

abstract contract Day2Admin {
    address public immutable admin = msg.sender;
    error Unauthorized();
    error Invalid();
    error BadState();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    function checkNewContract(address current, address target) internal view {
        if (current != address(0) || target.code.length == 0) revert Invalid();
    }
}

contract AgentRegistry is Day2Admin {
    struct Listing {
        address seller;
        uint256 priceWei;
        string metadataURI;
        bytes32 policyVersionHash;
        uint64 disputeWindow;
        bool active;
    }

    mapping(address => bool) public approvedSeller;
    mapping(bytes32 => Listing) private listings;
    event AgentRegistered(bytes32 indexed agentId, address indexed seller, uint256 priceWei);
    event AgentActiveChanged(bytes32 indexed agentId, bool active);
    event SellerApprovalChanged(address indexed seller, bool approved);

    function setSellerApproved(address seller, bool approved) external onlyAdmin {
        approvedSeller[seller] = approved;
        emit SellerApprovalChanged(seller, approved);
    }

    function registerAgent(bytes32 agentId, uint256 priceWei, string calldata uri,
        bytes32 version, uint64 window) external {
        if (!approvedSeller[msg.sender]) revert Unauthorized();
        if (agentId == 0 || listings[agentId].seller != address(0) ||
            priceWei == 0 || version == 0 || window == 0) revert Invalid();
        listings[agentId] = Listing(msg.sender, priceWei, uri, version, window, true);
        emit AgentRegistered(agentId, msg.sender, priceWei);
    }

    function setAgentActive(bytes32 agentId, bool active) external {
        Listing storage listing = listings[agentId];
        if (listing.seller == address(0)) revert Invalid();
        if (msg.sender != admin && msg.sender != listing.seller) revert Unauthorized();
        if (active && !approvedSeller[listing.seller]) revert Invalid();
        listing.active = active;
        emit AgentActiveChanged(agentId, active);
    }

    function getAgent(bytes32 agentId) external view returns (Listing memory) {
        return listings[agentId];
    }
}

contract MerchantPolicyRegistry is Day2Admin {
    struct Policy {
        bytes32 commitment;
        bytes32 version;
        uint64 purchaseTimestamp;
        uint64 claimDeadline;
    }

    address public orderManager;
    mapping(bytes32 => Policy) public policies;
    event PolicyRecorded(bytes32 indexed orderId, bytes32 commitment, bytes32 version,
        uint64 purchaseTimestamp, uint64 claimDeadline);

    function setOrderManager(address target) external onlyAdmin {
        checkNewContract(orderManager, target);
        orderManager = target;
    }

    function record(bytes32 orderId, bytes32 commitment, bytes32 version, uint64 deadline) external {
        if (msg.sender != orderManager) revert Unauthorized();
        if (policies[orderId].commitment != 0 || commitment == 0 || version == 0 ||
            deadline <= block.timestamp) revert Invalid();
        policies[orderId] = Policy(commitment, version, uint64(block.timestamp), deadline);
        emit PolicyRecorded(orderId, commitment, version, uint64(block.timestamp), deadline);
    }
}

contract SettlementEscrow is Day2Admin {
    struct Deposit {
        address buyer;
        address seller;
        uint256 amount;
        bool settled;
        bool warranty;
    }

    address public orderManager;
    uint256 public totalLocked;
    mapping(bytes32 => Deposit) public deposits;
    mapping(address => uint256) public claimable;
    event EscrowLocked(bytes32 indexed orderId, uint256 amount, bool warranty);
    event EscrowSettled(bytes32 indexed orderId, uint256 refundAmount, uint256 sellerAmount);
    event Withdrawal(address indexed account, uint256 amount);

    function setOrderManager(address target) external onlyAdmin {
        checkNewContract(orderManager, target);
        orderManager = target;
    }

    function lock(bytes32 id, address buyer, address seller, bool warranty) external payable {
        if (msg.sender != orderManager) revert Unauthorized();
        if (msg.value == 0 || deposits[id].amount != 0) revert Invalid();
        deposits[id] = Deposit(buyer, seller, msg.value, false, warranty);
        totalLocked += msg.value;
        emit EscrowLocked(id, msg.value, warranty);
    }

    function settle(bytes32 id, uint256 refundAmount) external {
        if (msg.sender != orderManager) revert Unauthorized();
        Deposit storage deposit = deposits[id];
        if (deposit.settled || deposit.amount == 0) revert BadState();
        if (refundAmount > deposit.amount) revert Invalid();
        deposit.settled = true;
        totalLocked -= deposit.amount;
        uint256 sellerAmount = deposit.amount - refundAmount;
        claimable[deposit.buyer] += refundAmount;
        claimable[deposit.seller] += sellerAmount;
        emit EscrowSettled(id, refundAmount, sellerAmount);
    }

    function withdraw() external {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert BadState();
        claimable[msg.sender] = 0;
        (bool success,) = payable(msg.sender).call{value: amount}("");
        if (!success) revert BadState();
        emit Withdrawal(msg.sender, amount);
    }
}
