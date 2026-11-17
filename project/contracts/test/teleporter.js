const {expect}=require('chai');
const {ethers}=require('hardhat');
describe('Strict Teleporter receiver',function(){
 it('rejects direct wallet calls and locks peer',async function(){
  const [owner,other]=await ethers.getSigners();
  const mock=await (await ethers.getContractFactory('MockMessenger')).deploy();
  const app=await (await ethers.getContractFactory('TeleporterPingPong')).deploy(await mock.getAddress());
  const chain=ethers.id('peer');await app.setPeer(chain,other.address);
  const data=ethers.AbiCoder.defaultAbiCoder().encode(['bytes32','string'],[ethers.id('payload'),'hello']);
  await expect(app.receiveTeleporterMessage(chain,other.address,data)).to.be.revertedWith('Only messenger');
  await expect(app.setPeer(chain,owner.address)).to.be.revertedWith('Peer locked');
  await expect(mock.deliver(await app.getAddress(),ethers.id('wrong'),other.address,data)).to.be.revertedWith('Untrusted origin');
  await expect(mock.deliver(await app.getAddress(),chain,other.address,data)).to.emit(app,'Received');
  await expect(mock.deliver(await app.getAddress(),chain,other.address,data)).to.be.revertedWith('Replay');
 });
});
