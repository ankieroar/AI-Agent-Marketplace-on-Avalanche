const hre = require("hardhat");

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

async function deployDay2({policyCommitmentFor, verifierName = "MockServicePolicyVerifier", sameChain = false} = {}) {
  if (!["hardhat", "localhost"].includes(hre.network.name)) throw new Error("Demo is local only");
  const { ethers } = hre;
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 31337n) throw new Error("Expected local chain ID 31337");
  const [admin, seller, buyer, reviewer, outsider] = await ethers.getSigners();
  const contracts = {};
  async function deploy(name, ...args) {
    const contract = await ethers.deployContract(name, args);
    await contract.waitForDeployment();
    contracts[name] = contract;
    return contract;
  }

  const send = async (transaction) => (await transaction).wait();
  const source = ethers.id("local-fuji");
  const dispute = sameChain ? source : ethers.id("local-dispute-l1");
  const fujiMessenger = sameChain ? await deploy("FujiDisputeMessenger", source) : await deploy("V2MockMessenger");
  const l1Messenger = sameChain ? fujiMessenger : await ethers.deployContract("V2MockMessenger");
  await l1Messenger.waitForDeployment();
  const agents = await deploy("AgentRegistry");
  const policies = await deploy("MerchantPolicyRegistry");
  const escrow = await deploy("SettlementEscrow");
  const orders = await deploy("ServiceOrderManager", agents, policies, escrow);
  const verifier = await deploy(verifierName);
  const gate = await deploy("ProofGate", verifier);
  const manager = await deploy("DisputeManager", gate, reviewer.address);
  const gateway = await deploy("MarketplaceGateway", fujiMessenger, source, orders);
  const inbox = await deploy("DisputeInbox", l1Messenger, manager);
  const sender = await deploy("DisputeResultSender", l1Messenger, manager);
  const receiver = await deploy("DisputeResultReceiver", fujiMessenger, orders);
  await send(policies.setOrderManager(orders));
  await send(escrow.setOrderManager(orders));
  await send(orders.configureDispute(gateway, receiver));
  await send(manager.setInbox(inbox));
  await send(gateway.setPeer(dispute, inbox));
  await send(inbox.setPeer(source, gateway));
  await send(sender.setPeer(source, receiver));
  await send(receiver.setPeer(dispute, sender));

  const agentId = ethers.id("document-summary");
  const version = ethers.id("document-summary-policy-v1");
  const price = ethers.parseEther("0.01");
  const window = 3600;
  await send(agents.setSellerApproved(seller.address, true));
  await send(agents.connect(seller).registerAgent(agentId, price, "ipfs://demo/document-summary", version, window));

  async function quote(label) {
    const salt = ethers.id(label);
    const orderId = await orders.orderIdFor(buyer.address, salt);
    const policyCommitment = policyCommitmentFor
      ? policyCommitmentFor(orderId, version) : ethers.id(`demo-policy:${orderId}`);
    const validUntil = (await ethers.provider.getBlock("latest")).timestamp + 600;
    const signature = ethers.Signature.from(await seller.signTypedData({
      name: "ServiceOrderManager", version: "1", chainId, verifyingContract: await orders.getAddress(),
    }, quoteTypes, { orderId, agentId, policyCommitment, policyVersionHash: version, priceWei: price, validUntil }));
    return { orderId, policyCommitment, args: [agentId, salt, policyCommitment, validUntil,
      signature.v, signature.r, signature.s] };
  }

  async function buy(label) {
    const item = await quote(label);
    await send(orders.connect(buyer).purchaseService(...item.args, { value: price }));
    return item.orderId;
  }

  async function open(id) {
    await send(gateway.connect(buyer).openCase(id));
    if (!sameChain) {
      const payload = await fujiMessenger.lastPayload();
      await send(l1Messenger.deliver(inbox, source, gateway, payload));
    }
    return (await orders.orders(id)).caseId;
  }

  async function fakeProof(caseId, amount, nullifier) {
    const { claim } = await manager.getCase(caseId);
    const inputs = await gate.publicInputs(claim.toObject(), amount, nullifier);
    return ethers.AbiCoder.defaultAbiCoder().encode(["bytes32[]"], [[...inputs]]);
  }

  return { admin, seller, buyer, reviewer, outsider, source, dispute, fujiMessenger, l1Messenger,
    contracts, agents, policies, escrow, orders, gate, manager, gateway, inbox, sender, receiver,
    agentId, version, price, window, send, quote, buy, open, fakeProof };
}

module.exports = { deployDay2 };
