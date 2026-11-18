// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./MarketplaceCore.sol";

library DisputeMessages {
    struct Claim {
        bytes32 caseId;
        bytes32 orderId;
        bytes32 policyCommitment;
        uint64 claimTimestamp;
        bytes32 policyVersionHash;
        bytes32 sourceBlockchainId;
        uint256 nonce;
        uint256 lockedAmount;
        uint64 purchaseTimestamp;
        uint64 claimDeadline;
    }

    struct Resolution {
        bytes32 caseId;
        bytes32 orderId;
        uint8 outcomeCode;
        uint256 payoutAmount;
        bytes32 reviewerApprovalRef;
        bytes32 proofRef;
        uint256 nonce;
    }

    function caseId(bytes32 source, address gateway, bytes32 orderId) internal pure returns (bytes32) {
        return keccak256(abi.encode(source, gateway, orderId));
    }
}

contract ServiceOrderManager is Day2Admin {
    enum Status { Missing, Paid, Delivered, Accepted, Disputed, Resolved, Expired }
    struct Order {
        bytes32 agentId;
        address buyer;
        address seller;
        uint256 priceWei;
        Status status;
        bytes32 resultHash;
        bytes32 caseId;
        bool warranty;
    }

    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "ServiceQuote(bytes32 orderId,bytes32 agentId,bytes32 policyCommitment,bytes32 policyVersionHash,uint256 priceWei,uint64 validUntil)"
    );
    uint256 private constant HALF_CURVE_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    AgentRegistry public immutable agents;
    MerchantPolicyRegistry public immutable policies;
    SettlementEscrow public immutable escrow;
    address public gateway;
    address public resultReceiver;
    mapping(bytes32 => Order) public orders;

    event ServicePurchased(bytes32 indexed orderId, bytes32 indexed agentId, address indexed buyer,
        address seller, uint256 priceWei, bytes32 policyCommitment, bytes32 policyVersionHash,
        uint64 purchaseTimestamp);
    event WarrantyRegistered(bytes32 indexed orderId, address indexed buyer, address indexed merchant);
    event OrderDelivered(bytes32 indexed orderId, bytes32 resultHash);
    event OrderStatusChanged(bytes32 indexed orderId, Status status);

    constructor(AgentRegistry agentRegistry, MerchantPolicyRegistry policyRegistry, SettlementEscrow funds) {
        agents = agentRegistry;
        policies = policyRegistry;
        escrow = funds;
    }

    function configureDispute(address gateway_, address receiver_) external onlyAdmin {
        checkNewContract(gateway, gateway_);
        checkNewContract(resultReceiver, receiver_);
        gateway = gateway_;
        resultReceiver = receiver_;
    }

    function orderIdFor(address buyer, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), buyer, salt));
    }

    function purchaseService(bytes32 agentId, bytes32 salt, bytes32 commitment, uint64 validUntil,
        uint8 v, bytes32 r, bytes32 s) external payable returns (bytes32 id) {
        AgentRegistry.Listing memory listing = agents.getAgent(agentId);
        if (!listing.active || !agents.approvedSeller(listing.seller) ||
            msg.value != listing.priceWei || block.timestamp > validUntil ||
            msg.sender == listing.seller || uint256(s) > HALF_CURVE_ORDER) revert Invalid();
        id = orderIdFor(msg.sender, salt);
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("ServiceOrderManager"),
            keccak256("1"), block.chainid, address(this)));
        bytes32 quote = keccak256(abi.encode(QUOTE_TYPEHASH, id, agentId, commitment,
            listing.policyVersionHash, listing.priceWei, validUntil));
        if (ecrecover(keccak256(abi.encodePacked(hex"1901", domain, quote)), v, r, s) != listing.seller)
            revert Unauthorized();

        _create(id, agentId, msg.sender, listing.seller, commitment, listing.policyVersionHash,
            uint64(block.timestamp) + listing.disputeWindow, false);
        emit ServicePurchased(id, agentId, msg.sender, listing.seller, msg.value, commitment,
            listing.policyVersionHash, uint64(block.timestamp));
    }

    function registerWarranty(address buyer, bytes32 salt, bytes32 commitment, bytes32 version,
        uint64 deadline) external payable returns (bytes32 id) {
        if (!agents.approvedSeller(msg.sender)) revert Unauthorized();
        if (buyer == address(0) || buyer == msg.sender) revert Invalid();
        id = keccak256(abi.encode(block.chainid, address(this), msg.sender, buyer, salt));
        _create(id, 0, buyer, msg.sender, commitment, version, deadline, true);
        emit WarrantyRegistered(id, buyer, msg.sender);
    }

    function _create(bytes32 id, bytes32 agentId, address buyer, address seller, bytes32 commitment,
        bytes32 version, uint64 deadline, bool warranty) private {
        if (gateway == address(0) || orders[id].status != Status.Missing) revert BadState();
        orders[id] = Order(agentId, buyer, seller, msg.value, Status.Paid, 0, 0, warranty);
        policies.record(id, commitment, version, deadline);
        escrow.lock{value: msg.value}(id, buyer, seller, warranty);
    }

    function markDelivered(bytes32 id, bytes32 resultHash) external {
        Order storage order = orders[id];
        if (msg.sender != order.seller) revert Unauthorized();
        (,,, uint64 deadline) = policies.policies(id);
        if (order.status != Status.Paid || order.warranty || resultHash == 0 ||
            block.timestamp > deadline) revert BadState();
        order.resultHash = resultHash;
        _setStatus(id, order, Status.Delivered);
        emit OrderDelivered(id, resultHash);
    }

    function accept(bytes32 id) external {
        Order storage order = orders[id];
        if (msg.sender != order.buyer) revert Unauthorized();
        if (order.status != Status.Delivered) revert BadState();
        _settle(id, order, Status.Accepted, 0);
    }

    function settleExpired(bytes32 id) external {
        Order storage order = orders[id];
        (,,, uint64 deadline) = policies.policies(id);
        if (block.timestamp <= deadline ||
            (order.status != Status.Paid && order.status != Status.Delivered)) revert BadState();
        uint256 refund = !order.warranty && order.status == Status.Paid ? order.priceWei : 0;
        _settle(id, order, Status.Expired, refund);
    }

    function markDisputed(bytes32 id, address buyer, bytes32 caseId) external returns (uint256) {
        if (msg.sender != gateway) revert Unauthorized();
        Order storage order = orders[id];
        if (buyer != order.buyer) revert Unauthorized();
        (,,, uint64 deadline) = policies.policies(id);
        if ((order.status != Status.Paid && order.status != Status.Delivered) ||
            block.timestamp > deadline) revert BadState();
        order.caseId = caseId;
        _setStatus(id, order, Status.Disputed);
        return order.priceWei;
    }

    function applyResolution(DisputeMessages.Resolution calldata resolution) external {
        if (msg.sender != resultReceiver) revert Unauthorized();
        Order storage order = orders[resolution.orderId];
        if (order.status != Status.Disputed || order.caseId != resolution.caseId) revert BadState();
        if (resolution.nonce != uint256(order.caseId) || resolution.reviewerApprovalRef == 0 ||
            resolution.payoutAmount > order.priceWei) revert Invalid();
        if (resolution.outcomeCode == 1) {
            if (resolution.payoutAmount == 0 || resolution.proofRef == 0) revert Invalid();
        } else if (resolution.outcomeCode != 2 || resolution.payoutAmount != 0 ||
            resolution.proofRef != 0) revert Invalid();
        _settle(resolution.orderId, order, Status.Resolved, resolution.payoutAmount);
    }

    function _settle(bytes32 id, Order storage order, Status status, uint256 refund) private {
        _setStatus(id, order, status);
        escrow.settle(id, refund);
    }

    function _setStatus(bytes32 id, Order storage order, Status status) private {
        order.status = status;
        emit OrderStatusChanged(id, status);
    }
}
