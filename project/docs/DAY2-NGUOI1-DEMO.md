# Day 2 · Demo Marketplace và Dispute local

## Chạy thử

Chạy từ thư mục `project/contracts`. Nếu đã cài dependencies ở `project`, dùng lại bản cài đó. Trên PowerShell Windows dùng `npx.cmd` nếu execution policy chặn `npx.ps1`.

```powershell
cd project/contracts
npx.cmd hardhat test
npx.cmd hardhat run scripts/day2-demo.js
```

Trên Linux/macOS, thay `npx.cmd` bằng `npx`. Nếu chỉ muốn chạy test Day 2, dùng `npx hardhat test test/day2-marketplace.js`.

Mặc định Hardhat tạo chain trong bộ nhớ. Muốn giữ địa chỉ cho backend/UI gọi qua RPC, mở hai terminal trong `project/contracts`:

1. Terminal 1: `npx.cmd hardhat node`.
2. Terminal 2: `npx.cmd hardhat run scripts/day2-demo.js --network localhost`.

RPC local là `http://127.0.0.1:8545`, chain ID `31337`. Script in địa chỉ deploy và xuất ABI kèm địa chỉ vào `project/contracts/artifacts/day2-local.json`. Nếu chạy mặc định trong bộ nhớ, địa chỉ chỉ dùng được trong lần chạy đó. Demo dùng tài khoản Hardhat, hai mock messenger và một mock verifier. Chỉ dùng các mock này trên local.

## Kết quả demo

- Đăng ký Document Summary Agent với giá **0,01 AVAX** và cửa sổ khiếu nại **1 giờ kể từ lúc mua**. Seller ký quote EIP-712, buyer gửi quote và tiền trong cùng giao dịch. Registry ghi commitment và version, escrow khóa tiền theo order.
- Order thứ nhất được seller đánh dấu đã bàn giao. Buyer accept, escrow ghi **0,01 AVAX** cho seller.
- Order thứ hai mở dispute. Mock chuyển case sang đầu nhận Dispute, reviewer xét proof giả lập và duyệt **0,005 AVAX**. Mock chuyển kết quả về, escrow ghi **0,005 AVAX** cho buyer, phần còn lại cho seller.
- Trước khi rút, `buyerClaimableWei` = `5000000000000000`, `sellerClaimableWei` = `15000000000000000`, `totalLockedWei` = `0`. Sau đó cả hai tài khoản gọi `withdraw()`.

## Handoff cho backend, UI và ZK

| Contract | API và event chính |
|---|---|
| `AgentRegistry` | Admin `setSellerApproved`, seller `registerAgent`, `setAgentActive`, UI đọc `getAgent`. |
| `ServiceOrderManager` | `orderIdFor`, `purchaseService` → `ServicePurchased`, `markDelivered` → `OrderDelivered`, `accept`, `settleExpired`, `orders`. |
| `MerchantPolicyRegistry` | `policies(orderId)`, `PolicyRecorded`. Commitment, version và hai mốc thời gian ghi một lần trong giao dịch tạo order. |
| `SettlementEscrow` | `EscrowLocked`, `EscrowSettled`, `claimable`, `withdraw`. Khoản warranty do merchant nộp qua `registerWarranty`, được hạch toán riêng theo order. |
| `MarketplaceGateway`, `DisputeInbox` | Buyer gọi `openCase(orderId)`; gateway phát `CaseOpened`; inbox kiểm tra messenger, blockchain ID, sender và case ID trước khi ghi case. |
| `DisputeManager`, `ProofGate` | `getCase`, `publicInputs`, `CaseStatusChanged`, `CaseProofVerified`. Reviewer điều khiển các bước phân tích, nộp proof và ra quyết định. |
| `DisputeResultSender`, `DisputeResultReceiver` | Reviewer gọi `sendResolution` → `CaseResolutionCommitted`; receiver kiểm tra nguồn, payload và chuyển kết quả cho order manager → `ResolutionApplied`. |

Order status theo thứ tự ABI `Missing, Paid, Delivered, Accepted, Disputed, Resolved, Expired`. Backend có thể theo dõi `RUNNING` riêng. Hết hạn, service chưa bàn giao được hoàn toàn bộ, service đã bàn giao trả seller và quỹ warranty chưa tranh chấp trả merchant. Order đã dispute đi qua quy trình review. Mỗi quyết định chỉ áp dụng một lần. Case status theo thứ tự ABI `Missing, Opened, Analyzing, ProofVerified, MerchantReview, Approved, Rejected`. Nếu review trước khi có proof thì chỉ có thể từ chối. Mã kết quả `1` là duyệt refund, `2` là từ chối.

Seller ký EIP-712 với domain `ServiceOrderManager`, version `1`, chain ID EVM và địa chỉ order manager. Kiểu `ServiceQuote` lần lượt gồm `orderId:bytes32, agentId:bytes32, policyCommitment:bytes32, policyVersionHash:bytes32, priceWei:uint256, validUntil:uint64`. Buyer chọn salt mới, lấy `orderIdFor(buyer,salt)` và gửi chữ ký tách `v,r,s`. `validUntil` là hạn quote. Hạn khiếu nại được tính riêng theo listing khi mua. Fixture ký mẫu nằm trong `scripts/day2-local-fixture.js`.

Payload ICM dùng `abi.encode(struct)`, với thứ tự và kiểu field trong `DisputeMessages`. Schema JSON tương ứng là `day2CaseMessageSchema` và `day2ResolutionMessageSchema` trong `packages/schema/index.mjs`. Số lớn truyền dưới dạng chuỗi thập phân, timestamp tính theo giây, tiền tính theo wei. `caseId = keccak256(abi.encode(sourceBlockchainId, gatewayAddress, orderId))`, `nonce = uint256(caseId)`. Khi tích hợp mạng thật, cấu hình blockchain ID dạng bytes32 cho ICM; chain ID EVM dùng cho ví và chữ ký.

ProofGate gọi `verify(bytes,bytes32[])`. Thứ tự 15 public inputs:

1. `caseId`, `orderId`, `policyCommitment`, `policyVersionHash`, `sourceBlockchainId`, mỗi giá trị tách thành hai field 128 bit theo thứ tự cao, thấp.
2. `claimTimestamp`, `payoutAmount`, `nullifier`, `purchaseTimestamp`, `claimDeadline`.

Circuit cần ràng buộc commitment với điều khoản đã ký, case/order/domain, mốc thời gian và mức refund thực tế. Hai mốc mua và hết hạn lấy từ order on-chain. Lúc ký quote, commitment có thể cam kết điều khoản có trước giao dịch như cửa sổ khiếu nại tương đối, mức refund tối đa và nonce riêng. Demo dùng commitment và proof fixture. Verifier Hello World của Day 1 có public inputs khác, cần verifier circuit policy của Người 2 để thay mock.

## Phần còn lại khi tích hợp Fuji

- Demo local kiểm tra contract qua stub ở cả hai chiều. Trên testnet, kết quả Day 1 đã xác nhận Fuji → Dispute L1, chiều Dispute L1 → Fuji vẫn chờ xử lý. Chưa deploy bộ Day 2 lên Fuji hoặc Dispute L1.
- Sau khi chốt circuit/verifier và xử lý relay chiều về, deploy contract từng chain với messenger thật và peer đúng blockchain ID. Nếu một case đã mở mà kết quả chưa relay về, order vẫn ở `Disputed` và tiền vẫn khóa. Day 2 chưa có cơ chế phục hồi riêng cho case bị treo.
