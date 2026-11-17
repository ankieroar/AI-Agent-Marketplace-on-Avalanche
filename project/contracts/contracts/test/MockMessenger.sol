// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
interface ITestReceiver {function receiveTeleporterMessage(bytes32,address,bytes calldata) external;}
contract MockMessenger {
 function deliver(address app,bytes32 source,address sender,bytes calldata payload) external {ITestReceiver(app).receiveTeleporterMessage(source,sender,payload);}
}
