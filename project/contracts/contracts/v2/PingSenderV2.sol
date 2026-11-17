// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "./CrossChainEndpoint.sol";
contract PingSenderV2 is CrossChainEndpoint {
 uint256 public nonce;
 uint256 public totalReplies;
 bytes32 public lastRoundTripId;
 mapping(bytes32=>bool) public pending;
 mapping(bytes32=>bool) public completed;
 event PingSent(bytes32 indexed roundTripId,bytes32 indexed messageID,string text);
 event ReplyReceived(bytes32 indexed roundTripId,bytes32 indexed source,address indexed sender,string text);
 constructor(address m) CrossChainEndpoint(m) {}
 function sendPing(string calldata text) external onlyOwner returns(bytes32 id) {
  bytes32 round=keccak256(abi.encode(block.chainid,address(this),nonce++));
  pending[round]=true;lastRoundTripId=round;
  id=_send(round,false,text,1000000);emit PingSent(round,id,text);
 }
 function receiveTeleporterMessage(bytes32 source,address sender,bytes calldata payload) external override {
  _authenticate(source,sender);
  (bytes32 round,bool reply,string memory text)=abi.decode(payload,(bytes32,bool,string));
  require(reply&&pending[round]&&!completed[round],"Unexpected reply");
  pending[round]=false;completed[round]=true;totalReplies++;
  emit ReplyReceived(round,source,sender,text);
 }
}

