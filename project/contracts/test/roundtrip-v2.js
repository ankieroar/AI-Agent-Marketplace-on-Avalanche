const {expect}=require('chai');const {ethers}=require('hardhat');
describe('Authenticated ICM roundtrip V2',function(){
 async function fixture(){
 const m=await(await ethers.getContractFactory('V2MockMessenger')).deploy();
 const ping=await(await ethers.getContractFactory('PingSenderV2')).deploy(await m.getAddress());
 const pong=await(await ethers.getContractFactory('PongReceiverV2')).deploy(await m.getAddress());
 const a=ethers.id('fuji'),b=ethers.id('l1');
 await ping.setPeer(b,await pong.getAddress());await pong.setPeer(a,await ping.getAddress());
 return {m,ping,pong,a,b};
 }
 it('ping -> authenticated delivery -> automatic pong -> correlated reply; rejects replay',async()=>{
 const {m,ping,pong,a,b}=await fixture();await ping.sendPing('hello');
 const round=await ping.lastRoundTripId(),request=await m.lastPayload();
 await expect(pong.receiveTeleporterMessage(a,await ping.getAddress(),request)).to.be.revertedWith('Only messenger');
 await expect(m.deliver(await pong.getAddress(),b,await ping.getAddress(),request)).to.be.revertedWith('Untrusted origin');
 await expect(m.deliver(await pong.getAddress(),a,await ping.getAddress(),request)).to.emit(pong,'PongReplied');
 const reply=await m.lastPayload();
 await expect(m.deliver(await ping.getAddress(),b,await pong.getAddress(),reply)).to.emit(ping,'ReplyReceived');
 expect(await ping.completed(round)).to.equal(true);expect(await ping.totalReplies()).to.equal(1n);
 await expect(m.deliver(await ping.getAddress(),b,await pong.getAddress(),reply)).to.be.revertedWith('Unexpected reply');
 await expect(m.deliver(await pong.getAddress(),a,await ping.getAddress(),request)).to.be.revertedWith('Unexpected ping');
 await expect(pong.replyPong(round)).to.be.revertedWith('No pending pong');
 });
 it('manual reply only exists after an authenticated ping; peer cannot be overwritten',async()=>{
 const {m,ping,pong,a,b}=await fixture();const round=ethers.id('missing');
 await expect(pong.replyPong(round)).to.be.revertedWith('No pending pong');
 await expect(ping.setPeer(b,await pong.getAddress())).to.be.revertedWith('Peer locked');
 await pong.setAutoReply(false);await ping.sendPing('manual');
 const id=await ping.lastRoundTripId();await m.deliver(await pong.getAddress(),a,await ping.getAddress(),await m.lastPayload());
 expect(await pong.replied(id)).to.equal(false);await pong.replyPong(id);expect(await pong.replied(id)).to.equal(true);
 });
});

