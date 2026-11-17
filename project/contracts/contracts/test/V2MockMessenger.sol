// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "../v2/CrossChainEndpoint.sol";
contract V2MockMessenger {
 bytes public lastPayload;
 address public lastDestination;
 function sendCrossChainMessage(V2MessageInput calldata input) external returns(bytes32) {
  lastPayload=input.message;lastDestination=input.destinationAddress;return keccak256(input.message);
 }
 function deliver(address app,bytes32 chain,address sender,bytes calldata data) external {
  IV2Receiver(app).receiveTeleporterMessage(chain,sender,data);
 }
}

