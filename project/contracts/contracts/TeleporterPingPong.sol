// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
struct PingFee { address feeTokenAddress; uint256 amount; }
struct PingInput {bytes32 destinationBlockchainID;address destinationAddress;PingFee feeInfo;uint256 requiredGasLimit;address[] allowedRelayerAddresses;bytes message;}
interface IPingMessenger {function sendCrossChainMessage(PingInput calldata input) external returns(bytes32);}
/// Day-1 transport test. No owner/relayer bypass is allowed on receive.
contract TeleporterPingPong {
 address public immutable messenger;
 address public immutable owner;
 bytes32 public peerBlockchainID;
 address public peer;
 uint256 public nonce;
 mapping(bytes32=>bool) public received;
 event Sent(bytes32 indexed messageID,bytes32 indexed payloadID,string text);
 event Received(bytes32 indexed payloadID,bytes32 indexed source,address indexed sender,string text);
 constructor(address m){require(m.code.length>0,"Messenger not deployed");messenger=m;owner=msg.sender;}
 function setPeer(bytes32 chain,address app) external {require(msg.sender==owner && peer==address(0),"Peer locked");require(chain!=0 && app!=address(0),"Invalid peer");peerBlockchainID=chain;peer=app;}
 function send(string calldata text) external returns(bytes32 id){
 require(peer!=address(0),"No peer");
 bytes32 payloadID=keccak256(abi.encode(block.chainid,address(this),nonce++));
 id=IPingMessenger(messenger).sendCrossChainMessage(PingInput(peerBlockchainID,peer,PingFee(address(0),0),300000,new address[](0),abi.encode(payloadID,text)));
 emit Sent(id,payloadID,text);
 }
 function receiveTeleporterMessage(bytes32 source,address sender,bytes calldata payload) external {
 require(msg.sender==messenger,"Only messenger");require(source==peerBlockchainID && sender==peer && peer!=address(0),"Untrusted origin");
 (bytes32 payloadID,string memory text)=abi.decode(payload,(bytes32,string));
 require(!received[payloadID],"Replay");received[payloadID]=true;emit Received(payloadID,source,sender,text);
 }
}

