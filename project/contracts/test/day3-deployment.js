// Day 3 / Person 1: deployment + wiring + cross-chain state machine tests.
// These run in-process (no node, no funds) and exercise exactly the helpers used by
// scripts/deploy-day3.js and scripts/day3-configure.js.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const {
  emptyManifest, deployFujiSide, deployL1Side, wireFuji, wireL1, inspectWiring,
  blockchainIdBytes32, decodeCb58, CHAINS,
} = require("../scripts/lib/day3-deploy");

const quoteTypes = {
  ServiceQuote: [
    { name: "orderId", type: "bytes32" },
    { name: "agentId", type: "bytes32" },
    { name: "policyCommitment", type: "bytes32" },
    { name: "policyVersionHash", type: "bytes32" },
    { name: "priceWei", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
};

describe("Day 3 deployment and two-domain wiring", function () {
  async function fixture() {
    const [admin, seller, buyer, reviewer, outsider] = await ethers.getSigners();
    const { chainId } = await ethers.provider.getNetwork();
    const sourceBytes32 = ethers.id("test-fuji-c-chain");
    const disputeBytes32 = ethers.id("test-dispute-l1");

    const fujiMessenger = await (await ethers.deployContract("V2MockMessenger")).waitForDeployment();
    const l1Messenger = await (await ethers.deployContract("V2MockMessenger")).waitForDeployment();

    const fujiManifest = emptyManifest({
      role: "fuji", network: "hardhat", chainId: Number(chainId),
      blockchainId: sourceBytes32, blockchainIdBytes32: sourceBytes32,
    });
    const fuji = await deployFujiSide({
      manifest: fujiManifest, messenger: await fujiMessenger.getAddress(),
    });

    const l1Manifest = emptyManifest({
      role: "dispute-l1", network: "hardhat", chainId: Number(chainId),
      blockchainId: disputeBytes32, blockchainIdBytes32: disputeBytes32,
    });
    l1Manifest.reviewer = reviewer.address;
    const l1 = await deployL1Side({
      manifest: l1Manifest, messenger: await l1Messenger.getAddress(), reviewer: reviewer.address,
      verifierName: "MockServicePolicyVerifier",
    });

    await wireFuji({
      contracts: fuji,
      peer: {
        blockchainIdBytes32: disputeBytes32,
        inbox: await l1.inbox.getAddress(),
        sender: await l1.sender.getAddress(),
      },
      manifest: fujiManifest,
    });
    await wireL1({
      contracts: l1,
      peer: {
        blockchainIdBytes32: sourceBytes32,
        gateway: await fuji.gateway.getAddress(),
        receiver: await fuji.receiver.getAddress(),
      },
      manifest: l1Manifest,
    });

    const agentId = ethers.id("document-summary");
    const version = ethers.id("document-summary-policy-v1");
    const price = ethers.parseEther("0.01");
    const send = async promise => (await promise).wait();

    await send(fuji.agents.setSellerApproved(seller.address, true));
    await send(fuji.agents.connect(seller).registerAgent(agentId, price, "ipfs://demo/document-summary", version, 3600));

    async function quote(label, amount = price) {
      const salt = ethers.id(label);
      const orderId = await fuji.orders.orderIdFor(buyer.address, salt);
      const policyCommitment = ethers.id(`test-policy:${orderId}`);
      const validUntil = (await ethers.provider.getBlock("latest")).timestamp + 900;
      const signature = ethers.Signature.from(await seller.signTypedData(
        { name: "ServiceOrderManager", version: "1", chainId, verifyingContract: await fuji.orders.getAddress() },
        quoteTypes,
        { orderId, agentId, policyCommitment, policyVersionHash: version, priceWei: amount, validUntil },
      ));
      return { orderId, policyCommitment, args: [agentId, salt, policyCommitment, validUntil, signature.v, signature.r, signature.s] };
    }

    async function buy(label) {
      const item = await quote(label);
      await send(fuji.orders.connect(buyer).purchaseService(...item.args, { value: price }));
      return item;
    }

    return {
      admin, seller, buyer, reviewer, outsider,
      fuji, l1, fujiManifest, l1Manifest, fujiMessenger, l1Messenger,
      sourceBytes32, disputeBytes32, agentId, version, price, send, quote, buy,
    };
  }

  beforeEach(async function () {
    Object.assign(this, await loadFixture(fixture));
  });

  it("decodes Avalanche cb58 blockchain IDs into the on-chain bytes32 form", function () {
    expect(blockchainIdBytes32(CHAINS.fuji.blockchainId))
      .to.equal("0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5");
    expect(blockchainIdBytes32("0x1ac4f03783f66f0733d25e7b8df833da1d739e7b20404cd2cfd867bf1d270539"))
      .to.equal("0x1ac4f03783f66f0733d25e7b8df833da1d739e7b20404cd2cfd867bf1d270539");
    expect(decodeCb58("yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp").checksumOk).to.equal(true);
    expect(() => blockchainIdBytes32("yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HXp"))
      .to.throw(/checksum/);
  });

  it("wires every peer, chain ID, role and order-manager link in both directions", async function () {
    const checks = await inspectWiring({ fuji: this.fuji, l1: this.l1, fujiManifest: this.fujiManifest, l1Manifest: this.l1Manifest });
    expect(checks.filter(item => !item.ok).map(item => item.id)).to.deep.equal([]);
    expect(checks).to.have.length.greaterThanOrEqual(20);

    // Idempotent re-run must not revert or duplicate transactions.
    const wiringBefore = this.fujiManifest.wiring.length;
    await wireFuji({
      contracts: this.fuji,
      peer: {
        blockchainIdBytes32: this.disputeBytes32,
        inbox: await this.l1.inbox.getAddress(),
        sender: await this.l1.sender.getAddress(),
      },
      manifest: this.fujiManifest,
    });
    await wireL1({
      contracts: this.l1,
      peer: {
        blockchainIdBytes32: this.sourceBytes32,
        gateway: await this.fuji.gateway.getAddress(),
        receiver: await this.fuji.receiver.getAddress(),
      },
      manifest: this.l1Manifest,
    });
    expect(this.fujiManifest.wiring.length).to.equal(wiringBefore);
    expect(this.fujiManifest.wiring.every(item => item.status === "already-set")).to.equal(true);
  });

  it("locks escrow and applies a reviewer reject resolution over the authenticated relay", async function () {
    const item = await this.buy("reject-order");
    expect((await this.fuji.orders.orders(item.orderId)).status).to.equal(1n); // Paid
    expect(await this.fuji.escrow.totalLocked()).to.equal(this.price);

    const receipt = await (await this.fuji.gateway.connect(this.buyer).openCase(item.orderId)).wait();
    const caseId = receipt.logs
      .map(log => { try { return this.fuji.gateway.interface.parseLog(log); } catch { return null; } })
      .find(log => log?.name === "CaseOpened").args.caseId;
    expect((await this.fuji.orders.orders(item.orderId)).status).to.equal(4n); // Disputed

    const claim = await this.fujiMessenger.lastPayload();
    await expect(this.l1Messenger.deliver(this.l1.inbox, this.sourceBytes32, this.outsider.address, claim))
      .to.be.revertedWith("Untrusted origin");
    await this.l1Messenger.deliver(this.l1.inbox, this.sourceBytes32, await this.fuji.gateway.getAddress(), claim);
    expect((await this.l1.manager.getCase(caseId)).status).to.equal(1n); // Opened
    await expect(this.l1Messenger.deliver(this.l1.inbox, this.sourceBytes32,
      await this.fuji.gateway.getAddress(), claim)).to.be.revertedWithCustomError(this.l1.manager, "BadState");

    const review = this.l1.manager.connect(this.reviewer);
    await expect(review.connect(this.outsider).startAnalysis(caseId))
      .to.be.revertedWithCustomError(this.l1.manager, "Unauthorized");
    await this.send(review.startAnalysis(caseId));
    await this.send(review.beginReview(caseId));
    await expect(review.decide(caseId, true, ethers.id("approval")))
      .to.be.revertedWithCustomError(this.l1.manager, "Invalid");
    await this.send(review.decide(caseId, false, ethers.id("approval")));
    await expect(this.l1.sender.connect(this.outsider).sendResolution(caseId))
      .to.be.revertedWith("Only reviewer");
    await this.send(this.l1.sender.connect(this.reviewer).sendResolution(caseId));

    const resolution = await this.l1Messenger.lastPayload();
    await expect(this.fujiMessenger.deliver(this.fuji.receiver, this.disputeBytes32,
      await this.l1.inbox.getAddress(), resolution)).to.be.revertedWith("Untrusted origin");
    await this.fujiMessenger.deliver(this.fuji.receiver, this.disputeBytes32,
      await this.l1.sender.getAddress(), resolution);
    expect((await this.fuji.orders.orders(item.orderId)).status).to.equal(5n); // Resolved
    expect(await this.fuji.escrow.claimable(this.buyer.address)).to.equal(0);
    expect(await this.fuji.escrow.claimable(this.seller.address)).to.equal(this.price);
    await expect(this.fujiMessenger.deliver(this.fuji.receiver, this.disputeBytes32,
      await this.l1.sender.getAddress(), resolution)).to.be.revertedWithCustomError(this.fuji.orders, "BadState");
  });

  it("requires a verified proof before an approved refund and settles it once", async function () {
    const refund = this.price / 2n;
    const item = await this.buy("approve-order");
    const receipt = await (await this.fuji.gateway.connect(this.buyer).openCase(item.orderId)).wait();
    const caseId = receipt.logs
      .map(log => { try { return this.fuji.gateway.interface.parseLog(log); } catch { return null; } })
      .find(log => log?.name === "CaseOpened").args.caseId;
    await this.l1Messenger.deliver(this.l1.inbox, this.sourceBytes32,
      await this.fuji.gateway.getAddress(), await this.fujiMessenger.lastPayload());

    const review = this.l1.manager.connect(this.reviewer);
    await this.send(review.startAnalysis(caseId));
    const { claim } = await this.l1.manager.getCase(caseId);
    const nullifier = ethers.toBeHex(7, 32);
    const inputs = await this.l1.gate.publicInputs(claim.toObject(), refund, nullifier);
    const proof = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32[]"], [[...inputs]]);

    await expect(review.submitProof(caseId, refund, nullifier, proof)).to.emit(this.l1.manager, "CaseProofVerified");
    await expect(review.submitProof(caseId, refund, nullifier, proof))
      .to.be.revertedWithCustomError(this.l1.manager, "BadState");
    await this.send(review.beginReview(caseId));
    await this.send(review.decide(caseId, true, ethers.id("approve")));
    await this.send(this.l1.sender.connect(this.reviewer).sendResolution(caseId));
    await this.fujiMessenger.deliver(this.fuji.receiver, this.disputeBytes32,
      await this.l1.sender.getAddress(), await this.l1Messenger.lastPayload());

    expect((await this.fuji.orders.orders(item.orderId)).status).to.equal(5n); // Resolved
    expect(await this.fuji.escrow.claimable(this.buyer.address)).to.equal(refund);
    expect(await this.fuji.escrow.claimable(this.seller.address)).to.equal(this.price - refund);
    await expect(this.fuji.escrow.connect(this.buyer).withdraw())
      .to.changeEtherBalance(this.buyer, refund);
  });

  it("keeps the escrow one-shot and rejects a second settlement attempt", async function () {
    const item = await this.buy("double-settle");
    await this.send(this.fuji.orders.connect(this.seller).markDelivered(item.orderId, ethers.id("output")));
    await this.send(this.fuji.orders.connect(this.buyer).accept(item.orderId));
    expect((await this.fuji.orders.orders(item.orderId)).status).to.equal(3n); // Accepted
    await expect(this.fuji.orders.connect(this.buyer).accept(item.orderId))
      .to.be.revertedWithCustomError(this.fuji.orders, "BadState");
    await expect(this.fuji.escrow.connect(this.outsider).withdraw())
      .to.be.revertedWithCustomError(this.fuji.escrow, "BadState");
    expect(await this.fuji.escrow.totalLocked()).to.equal(0);
  });
});
