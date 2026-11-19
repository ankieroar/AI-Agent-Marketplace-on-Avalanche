# Ngày 3 — Người 1 (Blockchain / Avalanche), sáng 08:30–12:00

Mục tiêu của plan: triển khai marketplace lên **Fuji C-Chain**, dispute stack lên **Dispute L1**,
xác thực allowlist Teleporter hai chiều và bàn giao **ABI + manifest** cho Người 2/3.

Tài liệu này mô tả phần đã hoàn thành, cách kiểm thử ngay trên máy, cách deploy testnet thật và
các điểm còn phụ thuộc hạ tầng.

---

## 1. Đối chiếu checklist của plan

| Việc trong plan | Trạng thái | File / lệnh |
|---|---|---|
| Deploy `AgentRegistry`, `ServiceOrderManager`, `SettlementEscrow`, `MarketplaceGateway`, `DisputeResultReceiver` lên Fuji | ✅ Script sẵn sàng, chưa chạy testnet (máy này không có `PRIVATE_KEY` có AVAX) | `project/contracts/scripts/deploy-day3.js` |
| Deploy `DisputeInbox`, `DisputeManager`, `ProofGate`, `DisputeResultSender`, verifier lên Dispute L1 | ✅ Script sẵn sàng, cùng lý do trên | cùng file, `--network disputeL1` |
| Xác thực Teleporter/relayer hai chiều, allowlist chain + sender, chain ID vs blockchain ID | ✅ Kiểm tra read-only 45 mục; local chạy thật 2 chiều qua mock messenger | `scripts/day3-verify.js`, `scripts/day3-configure.js`, `scripts/day3-local-e2e.js` |
| Chia sẻ ABI + `deployments/fuji.json`, `deployments/dispute-l1.json` | ✅ Schema + thư mục ABI; file thật sinh ra khi deploy | `project/deployments/README.md`, `project/deployments/abi/*.json` |

Phần **chưa thể chạy trên máy này**: giao dịch thật lên Fuji/L1. Lý do: `project/.env` không có
`PRIVATE_KEY` và không có ví testnet được nạp AVAX. Script đã được thiết kế để chỉ cần key đó là
chạy được, không cần sửa code.

---

## 2. Kiến trúc hai miền và các mối nối

```
Fuji C-Chain (EVM 43113)
  AgentRegistry ──► ServiceOrderManager ──► SettlementEscrow
                           │  ▲
                           ▼  │
                    MarketplaceGateway ──(Teleporter)──┐
                           ▲                          │
                  DisputeResultReceiver ◄─────────────┘
                           ▲
                  (Teleporter, chiều về)
Dispute L1 (EVM 662831)
  DisputeInbox ──► DisputeManager ──► ProofGate ──► Verifier
       ▲                 │
       │                 ▼
  (Teleporter)    DisputeResultSender ──(Teleporter)──► Fuji receiver
```

Các giá trị bị **lock vĩnh viễn** sau khi set (không đổi được nếu không redeploy):

| Vị trí | Giá trị | Ai set |
|---|---|---|
| `MerchantPolicyRegistry.orderManager` | `ServiceOrderManager` | admin |
| `SettlementEscrow.orderManager` | `ServiceOrderManager` | admin |
| `ServiceOrderManager.gateway` / `.resultReceiver` | gateway / receiver trên Fuji | admin, một lần |
| `MarketplaceGateway.peer` | `DisputeInbox` + blockchain ID của L1 | admin |
| `DisputeResultReceiver.peer` | `DisputeResultSender` + blockchain ID của L1 | admin |
| `DisputeManager.inbox` | `DisputeInbox` | admin, một lần |
| `DisputeInbox.peer` / `DisputeResultSender.peer` | gateway / receiver + blockchain ID của Fuji | admin |
| `DisputeManager.reviewer` | ví arbitrator | **immutable trong constructor** |

`MarketplaceGateway.sourceBlockchainId` lấy từ `FUJI_BLOCKCHAIN_ID` (cb58) và được decode thành
`bytes32` bằng `scripts/lib/day3-deploy.js`. Cùng một blockchain ID được dùng cho cả claim lẫn
resolution; nhầm EVM chain ID với Avalanche blockchain ID là lỗi phổ biến nhất của ICM.

---

## 3. Chạy thử ngay trên máy (không cần Docker, không cần ví thật)

### 3.1. Test tự động (nhanh nhất, không cần node)

```powershell
cd D:\Code\avalanche\project\contracts
npx.cmd hardhat test test/day3-deployment.js
```

Kết quả hiện tại: **5 passing**, phủ:

1. Decode cb58 → bytes32 (Fuji + L1), phát hiện sai checksum.
2. Wiring đủ 21 mối nối và chạy lại idempotent (không gửi tx trùng).
3. Mua → mở dispute → claim qua relay có xác thực → reviewer reject → resolution → order `Resolved`.
4. Approve có proof (mock verifier) → refund đúng một lần, nullifier không dùng lại.
5. Escrow một lần duy nhất; outsider không withdraw được.

### 3.2. Demo end-to-end có log giao dịch

Terminal 1 (nếu chưa chạy):

```powershell
cd D:\Code\avalanche\project\contracts
npx.cmd hardhat node
```

Terminal 2:

```powershell
cd D:\Code\avalanche\project\contracts
npx.cmd hardhat run scripts/day3-local-e2e.js --network localhost
```

Script deploy **đúng bộ contract thật** (chỉ thay Teleporter bằng `V2MockMessenger`), in ra địa chỉ
và tx hash từng bước, chạy 20 assertion và ghi manifest vào:

```
project/.runtime/day3/deployments/fuji.json
project/.runtime/day3/deployments/dispute-l1.json
project/.runtime/day3/deployments/abi/*.json
```

Kiểm tra lại hoàn toàn read-only:

```powershell
node scripts/day3-verify.js --dir ..\.runtime\day3\deployments --local
```

Kết quả hiện tại: **45/45 checks passed** (chain ID, bytecode, messenger, peer hai chiều,
reviewer, proof gate, order manager).

Kiểm tra tính idempotent của bước cấu hình:

```powershell
node scripts/day3-configure.js --local
# tất cả "already set", 21/21 wiring checks passed
```

---

## 4. Deploy testnet thật

### 4.1. Chuẩn bị

Trong `project/.env`:

```dotenv
PRIVATE_KEY=0x...                 # ví testnet có AVAX, dùng làm admin cả 2 chain
FUJI_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
DISPUTE_L1_RPC_URL=https://managed-nodes.avax.network/ext/bc/CnnZk7.../rpc
FUJI_BLOCKCHAIN_ID=yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp
DISPUTE_L1_BLOCKCHAIN_ID=CnnZk7teddWLgqy2BD74T6TDUD6oJJVR3DtZTAspXSDd2xCvz
TELEPORTER_MESSENGER=0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf
DAY3_REVIEWER=0x...               # ví arbitrator trên L1, KHÔNG đổi được sau deploy
# DAY3_VERIFIER_ADDRESS=0x...     # tuỳ chọn: tái sử dụng verifier đã deploy
```

`TELEPORTER_MESSENGER` có cùng địa chỉ trên Fuji và L1. `DAY3_REVIEWER` nên là ví riêng của
thành viên phụ trách review (không dùng chung ví deploy nếu demo vai trò).

### 4.2. Thứ tự lệnh

```powershell
cd D:\Code\avalanche\project\contracts
npm.cmd run compile

# 0) Kiểm tra RPC/chain ID/messenger/ID trước khi tiêu gas (không cần key)
node scripts/day3-preflight.js --read-only

# 1) Deploy (L1 trước hay Fuji trước đều được; script tự bỏ qua peer nếu manifest bên kia chưa có)
npx.cmd hardhat run scripts/deploy-day3.js --network disputeL1
npx.cmd hardhat run scripts/deploy-day3.js --network fuji

# 2) Hoàn tất allowlist hai chiều (idempotent). Thêm --dry-run để xem trước.
node scripts/day3-configure.js

# 3) Báo cáo cuối, exit code 1 nếu có mối nối sai.
node scripts/day3-verify.js
```

Trước khi deploy có thể chạy `node scripts/day3-preflight.js` (không có `--read-only`) để kiểm tra
thêm `PRIVATE_KEY`, số dư AVAX và `DAY3_REVIEWER`.

`deploy-day3.js` **resumable**: contract đã có trong manifest và còn bytecode sẽ được tái sử dụng.
Nếu bị ngắt giữa chừng, chạy lại đúng lệnh cũ. Chỉ dùng `DAY3_FORCE_DEPLOY=1` khi thực sự muốn
deploy lại toàn bộ (địa chỉ đổi → phải redeploy cả hai phía vì peer đã lock).

### 4.3. Ý nghĩa kết quả

- Manifest Fuji có 6 contract; manifest L1 có 5 (gồm `Verifier`).
- `wiring[]` ghi `sent` / `already-set` / `planned` cho từng mối nối.
- `node scripts/day3-verify.js` in bảng PASS/FAIL. Chỉ khi **tất cả PASS** mới bàn giao cho
  Người 2/3.

### 4.4. Xác thực Teleporter hai chiều (sau khi có order thật)

Wiring đúng là điều kiện cần; giao thông ICM thật cần relayer:

```powershell
# Kiểm tra transport Day 1 (ping-pong) vẫn thông
npm.cmd run icm:check

# Hoặc chạy vòng roundtrip có xác thực đầy đủ (cần relayer đang chạy theo README Day 1)
npm.cmd run icm:roundtrip:api
```

Với luồng Day 3, message thật là:

- `MarketplaceGateway.openCase` → `CaseOpened` → `DisputeInbox` trên L1.
- `DisputeResultSender.sendResolution` → resolution → `DisputeResultReceiver` trên Fuji.

`V2MockMessenger` chỉ dùng local; trên testnet hai contract này nhận `TeleporterMessenger` thật và
chỉ chấp nhận `msg.sender == messenger`, đúng `sourceBlockchainID` và đúng peer đã lock.

---

## 5. Bàn giao cho Người 2 / Người 3

| Thứ cần dùng | Vị trí |
|---|---|
| Địa chỉ + chain ID Fuji | `project/deployments/fuji.json` |
| Địa chỉ + chain ID L1 | `project/deployments/dispute-l1.json` |
| ABI cho viem/wagmi/ethers | `project/deployments/abi/<Contract>.json` |
| Trạng thái wiring | mảng `wiring[]` trong 2 manifest |
| Script kiểm tra | `node scripts/day3-verify.js` |

Web hiện đọc địa chỉ local từ `.runtime/day2/day2-local.json` qua `/api/day3/config`. Khi chuyển
sang testnet, Người 3 chỉ cần map manifest Day 3 vào `NEXT_PUBLIC_FUJI_*` / `NEXT_PUBLIC_L1_*`
(không có key bí mật trong manifest).

---

## 6. Giới hạn và việc còn lại

1. **Chưa có giao dịch testnet thật** trong phiên này: thiếu `PRIVATE_KEY` có AVAX trên máy.
   Mọi thứ còn lại đã chạy và được assert ở local.
2. **Verifier thật**: `ServicePolicyUltraVerifier` ~11 KB, nằm dưới giới hạn EIP-170 24 KB.
   Local dùng `MockServicePolicyVerifier` cho nhánh approve; proof thật vẫn phụ thuộc
   `services/prover` + `circuits/service_policy/target` (Người 2).
3. **Reviewer immutable**: đổi ví reviewer phải redeploy `DisputeManager` + `DisputeInbox` +
   `DisputeResultSender` và cấu hình lại peer L1. Chọn đúng ví trước khi deploy.
4. **Peer lock**: `setPeer`/`setInbox`/`setOrderManager` chỉ set một lần. Nếu verify báo
   `actual ... expected ...`, phải redeploy cả hai phía rồi chạy lại `day3-configure.js`.
5. **Relayer**: cần chạy ICM relayer/self-delivery theo README Day 1 để claim và resolution qua
   Teleporter thật; local dùng mock messenger nên không cần.
6. Manifest testnet **chưa được commit** vì chưa deploy; sau khi deploy, commit
   `project/deployments/fuji.json`, `dispute-l1.json`, `abi/` (chỉ địa chỉ public).

---

## 7. Bằng chứng kiểm thử trong phiên này

```text
node scripts/day3-preflight.js --read-only
  8/8 checks passed
  fuji 43113 messenger 13013 bytes, L1 662831 messenger 12569 bytes
  blockchain IDs decode to 0x7fc93d85…10d5 and 0x1ac4f037…0539

npx hardhat test test/day3-deployment.js
  5 passing

npx hardhat run scripts/day3-local-e2e.js --network localhost
  20 checks passed
  manifests: .runtime/day3/deployments/{fuji,dispute-l1}.json

node scripts/day3-verify.js --dir ..\.runtime\day3\deployments --local
  45/45 checks passed

node scripts/day3-configure.js --local
  All 21 wiring checks passed

npx hardhat test
  14 passing, 2 pending (2 test proof thật cần prover)
```
