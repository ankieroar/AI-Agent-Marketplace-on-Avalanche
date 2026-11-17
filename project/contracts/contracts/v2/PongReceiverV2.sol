// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "./CrossChainEndpoint.sol";
contract PongReceiverV2 is CrossChainEndpoint {
 bool public autoReply=true;
 uint256 public totalReceivedMessages;
 mapping(bytes32=>bool) public received;
 mapping(bytes32=>bool) public replied;
 mapping(bytes32=>string) private texts;
 mapping(bytes32=>bytes32) public replyMessageIDs;
 event PongReceived(bytes32 indexed roundTripId,bytes32 indexed source,address indexed sender,string text);
 event PongReplied(bytes32 indexed roundTripId,bytes32 indexed messageID);
 constructor(address m) CrossChainEndpoint(m) {}
 function setAutoReply(bool enabled) external onlyOwner {autoReply=enabled;}
 function receiveTeleporterMessage(bytes32 source,address sender,bytes calldata payload) external override {
  _authenticate(source,sender);
  (bytes32 round,bool reply,string memory text)=abi.decode(payload,(bytes32,bool,string));
  require(!reply&&!received[round],"Unexpected ping");
  received[round]=true;texts[round]=text;totalReceivedMessages++;
  emit PongReceived(round,source,sender,text);
  if(autoReply)replyPong(round);
 }
 function replyPong(bytes32 round) public returns(bytes32 id) {
  require(received[round]&&!replied[round],"No pending pong");
  replied[round]=true;id=_send(round,true,texts[round],300000);
  replyMessageIDs[round]=id;delete texts[round];
  emit PongReplied(round,id);
 }
}

