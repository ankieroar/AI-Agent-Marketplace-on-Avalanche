// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../v2/CrossChainEndpoint.sol";
import "./ServiceOrderManager.sol";

abstract contract DisputeEndpoint is CrossChainEndpoint {
    uint256 private constant DELIVERY_GAS = 500_000;

    constructor(address messenger_) CrossChainEndpoint(messenger_) {}

    function _dispatch(bytes memory payload) internal returns (bytes32) {
        require(peer != address(0), "No peer");
        return IV2Messenger(messenger).sendCrossChainMessage(V2MessageInput(
            peerBlockchainID, peer, V2Fee(address(0), 0), DELIVERY_GAS, new address[](0), payload
        ));
    }
}

contract MarketplaceGateway is DisputeEndpoint {
    ServiceOrderManager public immutable orders;
    bytes32 public immutable sourceBlockchainId;
    event CaseOpened(bytes32 indexed caseId, bytes32 indexed orderId, bytes32 policyCommitment,
        uint64 claimTimestamp, bytes32 policyVersionHash, bytes32 sourceBlockchainId,
        uint256 nonce, bytes32 messageId);

    constructor(address messenger_, bytes32 source, ServiceOrderManager orders_)
        DisputeEndpoint(messenger_) {
        require(source != 0, "Missing source");
        sourceBlockchainId = source;
        orders = orders_;
    }

    function openCase(bytes32 id) external returns (bytes32 caseId) {
        caseId = DisputeMessages.caseId(sourceBlockchainId, address(this), id);
        uint256 amount = orders.markDisputed(id, msg.sender, caseId);
        (bytes32 commitment, bytes32 version, uint64 purchased, uint64 deadline) = orders.policies().policies(id);
        DisputeMessages.Claim memory claim = DisputeMessages.Claim(caseId, id, commitment,
            uint64(block.timestamp), version, sourceBlockchainId, uint256(caseId), amount, purchased, deadline);
        bytes32 messageId = _dispatch(abi.encode(claim));
        emit CaseOpened(caseId, id, commitment, claim.claimTimestamp, version,
            sourceBlockchainId, claim.nonce, messageId);
    }

    function receiveTeleporterMessage(bytes32, address, bytes calldata) external pure override {
        revert("Send only");
    }
}

interface IServicePolicyVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

contract ProofGate {
    IServicePolicyVerifier public immutable verifier;
    uint256 private constant FIELD_MODULUS =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    constructor(IServicePolicyVerifier verifier_) {
        require(address(verifier_).code.length > 0, "Missing verifier");
        verifier = verifier_;
    }

    function publicInputs(DisputeMessages.Claim calldata claim, uint256 amount, bytes32 nullifier)
        public pure returns (bytes32[] memory inputs) {
        require(amount > 0 && amount <= claim.lockedAmount && amount < FIELD_MODULUS &&
            uint256(nullifier) > 0 && uint256(nullifier) < FIELD_MODULUS, "Invalid proof inputs");
        inputs = new bytes32[](15);
        _split(inputs, 0, claim.caseId);
        _split(inputs, 2, claim.orderId);
        _split(inputs, 4, claim.policyCommitment);
        _split(inputs, 6, claim.policyVersionHash);
        _split(inputs, 8, claim.sourceBlockchainId);
        inputs[10] = bytes32(uint256(claim.claimTimestamp));
        inputs[11] = bytes32(amount);
        inputs[12] = nullifier;
        inputs[13] = bytes32(uint256(claim.purchaseTimestamp));
        inputs[14] = bytes32(uint256(claim.claimDeadline));
    }

    function _split(bytes32[] memory inputs, uint256 i, bytes32 value) private pure {
        inputs[i] = bytes32(uint256(value) >> 128);
        inputs[i + 1] = bytes32(uint256(uint128(uint256(value))));
    }

    function verify(DisputeMessages.Claim calldata claim, uint256 amount, bytes32 nullifier,
        bytes calldata proof) external view returns (bool) {
        return verifier.verify(proof, publicInputs(claim, amount, nullifier));
    }
}

contract DisputeManager is Day2Admin {
    enum Status { Missing, Opened, Analyzing, ProofVerified, MerchantReview, Approved, Rejected }
    struct Case {
        DisputeMessages.Claim claim;
        Status status;
        uint256 payoutAmount;
        bytes32 proofRef;
        bytes32 reviewerApprovalRef;
    }

    address public inbox;
    address public immutable reviewer;
    ProofGate public immutable proofGate;
    mapping(bytes32 => Case) private cases;
    mapping(bytes32 => bool) public usedNullifier;
    event CaseStatusChanged(bytes32 indexed caseId, Status status);
    event CaseProofVerified(bytes32 indexed caseId, uint256 payoutAmount, bytes32 proofRef, bytes32 nullifier);

    constructor(ProofGate gate, address reviewer_) {
        if (reviewer_ == address(0)) revert Invalid();
        proofGate = gate;
        reviewer = reviewer_;
    }

    modifier onlyReviewer() {
        if (msg.sender != reviewer) revert Unauthorized();
        _;
    }

    function setInbox(address target) external onlyAdmin {
        checkNewContract(inbox, target);
        inbox = target;
    }

    function getCase(bytes32 id) external view returns (Case memory) {
        return cases[id];
    }

    function ingest(DisputeMessages.Claim calldata claim) external {
        if (msg.sender != inbox) revert Unauthorized();
        Case storage item = cases[claim.caseId];
        if (item.status != Status.Missing) revert BadState();
        item.claim = claim;
        _transition(item, Status.Opened);
    }

    function startAnalysis(bytes32 id) external onlyReviewer {
        Case storage item = cases[id];
        if (item.status != Status.Opened) revert BadState();
        _transition(item, Status.Analyzing);
    }

    function submitProof(bytes32 id, uint256 amount, bytes32 nullifier, bytes calldata proof)
        external onlyReviewer {
        Case storage item = cases[id];
        if (item.status != Status.Analyzing || usedNullifier[nullifier]) revert BadState();
        if (!proofGate.verify(item.claim, amount, nullifier, proof)) revert Invalid();
        usedNullifier[nullifier] = true;
        item.payoutAmount = amount;
        item.proofRef = keccak256(proof);
        _transition(item, Status.ProofVerified);
        emit CaseProofVerified(id, amount, item.proofRef, nullifier);
    }

    function beginReview(bytes32 id) external onlyReviewer {
        Case storage item = cases[id];
        if (item.status != Status.ProofVerified && item.status != Status.Analyzing) revert BadState();
        _transition(item, Status.MerchantReview);
    }

    function decide(bytes32 id, bool approve, bytes32 approvalRef) external onlyReviewer {
        Case storage item = cases[id];
        if (item.status != Status.MerchantReview) revert BadState();
        if (approvalRef == 0 || (approve && item.proofRef == 0)) revert Invalid();
        item.reviewerApprovalRef = approvalRef;
        _transition(item, approve ? Status.Approved : Status.Rejected);
    }

    function resolutionFor(bytes32 id) external view returns (DisputeMessages.Resolution memory) {
        Case storage item = cases[id];
        bool approved = item.status == Status.Approved;
        if (!approved && item.status != Status.Rejected) revert BadState();
        return DisputeMessages.Resolution(id, item.claim.orderId, approved ? 1 : 2,
            approved ? item.payoutAmount : 0, item.reviewerApprovalRef,
            approved ? item.proofRef : bytes32(0), item.claim.nonce);
    }

    function _transition(Case storage item, Status status) private {
        item.status = status;
        emit CaseStatusChanged(item.claim.caseId, status);
    }
}

contract DisputeInbox is DisputeEndpoint {
    DisputeManager public immutable manager;

    constructor(address messenger_, DisputeManager manager_) DisputeEndpoint(messenger_) {
        manager = manager_;
    }

    function receiveTeleporterMessage(bytes32 source, address sender, bytes calldata payload) external override {
        _authenticate(source, sender);
        DisputeMessages.Claim memory claim = abi.decode(payload, (DisputeMessages.Claim));
        require(claim.sourceBlockchainId == source &&
            claim.caseId == DisputeMessages.caseId(source, sender, claim.orderId) &&
            claim.nonce == uint256(claim.caseId) && claim.policyCommitment != 0 &&
            claim.policyVersionHash != 0 && claim.purchaseTimestamp != 0 && claim.lockedAmount != 0 &&
            claim.claimTimestamp >= claim.purchaseTimestamp && claim.claimTimestamp <= claim.claimDeadline,
            "Invalid claim");
        manager.ingest(claim);
    }
}

contract DisputeResultSender is DisputeEndpoint {
    DisputeManager public immutable manager;
    mapping(bytes32 => bool) public sent;
    event CaseResolutionCommitted(bytes32 indexed caseId, bytes32 indexed orderId,
        uint8 outcomeCode, uint256 payoutAmount, bytes32 reviewerApprovalRef,
        bytes32 proofRef, uint256 nonce, bytes32 messageId);

    constructor(address messenger_, DisputeManager manager_) DisputeEndpoint(messenger_) {
        manager = manager_;
    }

    function sendResolution(bytes32 caseId) external returns (bytes32 messageId) {
        require(msg.sender == manager.reviewer(), "Only reviewer");
        require(!sent[caseId], "Already sent");
        DisputeMessages.Resolution memory resolution = manager.resolutionFor(caseId);
        sent[caseId] = true;
        messageId = _dispatch(abi.encode(resolution));
        emit CaseResolutionCommitted(caseId, resolution.orderId, resolution.outcomeCode,
            resolution.payoutAmount, resolution.reviewerApprovalRef, resolution.proofRef,
            resolution.nonce, messageId);
    }

    function receiveTeleporterMessage(bytes32, address, bytes calldata) external pure override {
        revert("Send only");
    }
}

contract DisputeResultReceiver is DisputeEndpoint {
    ServiceOrderManager public immutable orders;
    event ResolutionApplied(bytes32 indexed caseId, bytes32 indexed orderId, uint256 payoutAmount);

    constructor(address messenger_, ServiceOrderManager orders_) DisputeEndpoint(messenger_) {
        orders = orders_;
    }

    function receiveTeleporterMessage(bytes32 source, address sender, bytes calldata payload) external override {
        _authenticate(source, sender);
        DisputeMessages.Resolution memory resolution = abi.decode(payload, (DisputeMessages.Resolution));
        orders.applyResolution(resolution);
        emit ResolutionApplied(resolution.caseId, resolution.orderId, resolution.payoutAmount);
    }
}
