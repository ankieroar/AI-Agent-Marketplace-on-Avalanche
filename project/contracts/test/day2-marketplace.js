const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployDay2 } = require("../scripts/day2-local-fixture");

describe("Day 2 service marketplace and dispute", function () {
  it("restricts listing creation and records the seller-signed policy and escrow atomically", async function () {
    const d = await loadFixture(deployDay2);
    const item = await d.quote("checkout");
    const checkout = d.orders.connect(d.buyer);
    await expect(d.agents.connect(d.outsider).registerAgent(
      ethers.id("unauthorized"), d.price, "ipfs://demo", d.version, d.window,
    )).to.be.revertedWithCustomError(d.agents, "Unauthorized");
    await expect(checkout.purchaseService(...item.args, { value: d.price - 1n }))
      .to.be.revertedWithCustomError(d.orders, "Invalid");
    await d.send(d.agents.connect(d.seller).setAgentActive(d.agentId, false));
    await expect(checkout.purchaseService(...item.args, { value: d.price }))
      .to.be.revertedWithCustomError(d.orders, "Invalid");
    await d.send(d.agents.connect(d.seller).setAgentActive(d.agentId, true));
    const changed = [...item.args];
    changed[2] = ethers.id("changed-policy");
    await expect(checkout.purchaseService(...changed, { value: d.price }))
      .to.be.revertedWithCustomError(d.orders, "Unauthorized");
    await expect(d.orders.connect(d.outsider).purchaseService(...item.args, { value: d.price }))
      .to.be.revertedWithCustomError(d.orders, "Unauthorized");

    await expect(checkout.purchaseService(...item.args, { value: d.price }))
      .to.emit(d.orders, "ServicePurchased").and.to.emit(d.escrow, "EscrowLocked");
    const policy = await d.policies.policies(item.orderId);
    expect(policy.commitment).to.equal(item.policyCommitment);
    expect(policy.version).to.equal(d.version);
    expect(policy.claimDeadline - policy.purchaseTimestamp).to.equal(d.window);
    expect(await d.escrow.totalLocked()).to.equal(d.price);
    await expect(checkout.purchaseService(...item.args, { value: d.price }))
      .to.be.revertedWithCustomError(d.orders, "BadState");
  });

  it("settles accepted orders and applies timeout rules to undelivered and delivered orders", async function () {
    const d = await loadFixture(deployDay2);
    const accepted = await d.buy("accepted");
    const expired = await d.buy("expired");
    const delivered = await d.buy("delivered");
    await expect(d.orders.connect(d.buyer).markDelivered(accepted, ethers.id("output")))
      .to.be.revertedWithCustomError(d.orders, "Unauthorized");
    for (const id of [accepted, delivered]) {
      await d.send(d.orders.connect(d.seller).markDelivered(id, ethers.id("output")));
    }
    await d.send(d.orders.connect(d.buyer).accept(accepted));
    await expect(d.gateway.connect(d.buyer).openCase(accepted))
      .to.be.revertedWithCustomError(d.orders, "BadState");
    await expect(d.orders.settleExpired(expired)).to.be.revertedWithCustomError(d.orders, "BadState");
    await time.increase(d.window + 1);
    await expect(d.gateway.connect(d.buyer).openCase(expired))
      .to.be.revertedWithCustomError(d.orders, "BadState");
    await d.send(d.orders.settleExpired(expired));
    await d.send(d.orders.settleExpired(delivered));
    expect(await d.escrow.claimable(d.buyer.address)).to.equal(d.price);
    expect(await d.escrow.claimable(d.seller.address)).to.equal(2n * d.price);
    expect(await d.escrow.totalLocked()).to.equal(0);
  });

  it("authenticates both message legs and applies only the proof-bound refund once", async function () {
    const d = await loadFixture(deployDay2);
    const id = await d.buy("disputed");
    await expect(d.gateway.connect(d.outsider).openCase(id))
      .to.be.revertedWithCustomError(d.orders, "Unauthorized");
    const caseId = await d.open(id);
    const opening = await d.fujiMessenger.lastPayload();
    await expect(d.inbox.receiveTeleporterMessage(d.source, d.gateway, opening)).to.be.revertedWith("Only messenger");
    await expect(d.l1Messenger.deliver(d.inbox, d.source, d.outsider.address, opening))
      .to.be.revertedWith("Untrusted origin");
    await expect(d.l1Messenger.deliver(d.inbox, d.dispute, d.gateway, opening))
      .to.be.revertedWith("Untrusted origin");
    await expect(d.l1Messenger.deliver(d.inbox, d.source, d.gateway, opening))
      .to.be.revertedWithCustomError(d.manager, "BadState");
    await expect(d.orders.connect(d.buyer).accept(id)).to.be.revertedWithCustomError(d.orders, "BadState");
    await expect(d.manager.connect(d.outsider).startAnalysis(caseId))
      .to.be.revertedWithCustomError(d.manager, "Unauthorized");

    const review = d.manager.connect(d.reviewer);
    const amount = d.price / 2n;
    const nullifier = ethers.toBeHex(1, 32);
    await d.send(review.startAnalysis(caseId));
    const proof = await d.fakeProof(caseId, amount, nullifier);
    await expect(review.submitProof(caseId, amount + 1n, nullifier, proof))
      .to.be.revertedWithCustomError(d.manager, "Invalid");
    await expect(review.submitProof(caseId, d.price + 1n, nullifier, proof))
      .to.be.revertedWith("Invalid proof inputs");
    await d.send(review.submitProof(caseId, amount, nullifier, proof));
    await d.send(review.beginReview(caseId));
    await d.send(review.decide(caseId, true, ethers.id("review")));
    await expect(d.sender.connect(d.outsider).sendResolution(caseId)).to.be.revertedWith("Only reviewer");
    await d.send(d.sender.connect(d.reviewer).sendResolution(caseId));
    await expect(d.sender.connect(d.reviewer).sendResolution(caseId)).to.be.revertedWith("Already sent");

    const result = await d.l1Messenger.lastPayload();
    await expect(d.receiver.receiveTeleporterMessage(d.dispute, d.sender, result)).to.be.revertedWith("Only messenger");
    await expect(d.fujiMessenger.deliver(d.receiver, d.dispute, d.gateway, result))
      .to.be.revertedWith("Untrusted origin");
    const deliver = () => d.fujiMessenger.deliver(d.receiver, d.dispute, d.sender, result);
    await expect(deliver()).to.emit(d.escrow, "EscrowSettled").withArgs(id, amount, d.price - amount);
    await expect(deliver()).to.be.revertedWithCustomError(d.orders, "BadState");
    expect(await d.escrow.claimable(d.buyer.address)).to.equal(amount);
    await expect(d.escrow.connect(d.buyer).withdraw()).to.changeEtherBalance(d.buyer, amount);
    await expect(d.escrow.connect(d.buyer).withdraw()).to.be.revertedWithCustomError(d.escrow, "BadState");

    const nextCase = await d.open(await d.buy("second-case"));
    await d.send(review.startAnalysis(nextCase));
    await expect(review.submitProof(nextCase, amount, nullifier, proof))
      .to.be.revertedWithCustomError(d.manager, "BadState");
  });

  it("requires proof for approval and keeps merchant warranty funds tied to their order", async function () {
    const d = await loadFixture(deployDay2);
    const warranty = d.orders.connect(d.seller);
    const args = [d.buyer.address, ethers.id("warranty"), ethers.id("warranty-policy"),
      d.version, (await time.latest()) + 100];
    const id = await warranty.registerWarranty.staticCall(...args, { value: d.price });
    await d.send(warranty.registerWarranty(...args, { value: d.price }));
    expect((await d.escrow.deposits(id)).warranty).to.equal(true);
    const caseId = await d.open(id);
    const review = d.manager.connect(d.reviewer);
    await d.send(review.startAnalysis(caseId));
    await d.send(review.beginReview(caseId));
    const approvalRef = ethers.id("review");
    await expect(review.decide(caseId, true, approvalRef)).to.be.revertedWithCustomError(d.manager, "Invalid");
    await d.send(review.decide(caseId, false, approvalRef));
    await d.send(d.sender.connect(d.reviewer).sendResolution(caseId));
    await d.send(d.fujiMessenger.deliver(d.receiver, d.dispute, d.sender, await d.l1Messenger.lastPayload()));
    expect(await d.escrow.claimable(d.buyer.address)).to.equal(0);
    expect(await d.escrow.claimable(d.seller.address)).to.equal(d.price);
  });
});
