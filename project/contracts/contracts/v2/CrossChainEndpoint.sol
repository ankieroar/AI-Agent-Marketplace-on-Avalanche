// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
struct V2Fee { address feeTokenAddress; uint256 amount; }
struct V2MessageInput { bytes32 destinationBlockchainID; address destinationAddress; V2Fee feeInfo; uint256 requiredGasLimit; address[] allowedRelayerAddresses; bytes message; }
interface IV2Messenger { function sendCrossChainMessage(V2MessageInput calldata input) external returns(bytes32); }
interface IV2Receiver { function receiveTeleporterMessage(bytes32 source,address sender,bytes calldata payload) external; }
abstract contract CrossChainEndpoint is IV2Receiver {
 address public immutable messenger;
 address public immutable owner;
 bytes32 public peerBlockchainID;
 address public peer;
 constructor(address m) { require(m.code.length>0,"Missing messenger");messenger=m;owner=msg.sender; }
 modifier onlyOwner() { require(msg.sender==owner,"Only owner");_; }
 function setPeer(bytes32 chain,address app) external onlyOwner {
  require(peer==address(0),"Peer locked");require(chain!=bytes32(0)&&app!=address(0),"Invalid peer");
  peerBlockchainID=chain;peer=app;
 }
 function _authenticate(bytes32 source,address sender) internal view {
  require(msg.sender==messenger,"Only messenger");
  require(peer!=address(0)&&source==peerBlockchainID&&sender==peer,"Untrusted origin");
 }
 function _send(bytes32 round,bool reply,string memory text,uint256 gasLimit) internal returns(bytes32) {
  require(peer!=address(0),"No peer");
  return IV2Messenger(messenger).sendCrossChainMessage(V2MessageInput(peerBlockchainID,peer,V2Fee(address(0),0),gasLimit,new address[](0),abi.encode(round,reply,text)));
 }
}

