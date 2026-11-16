# Avalanche Private Warranty & Dispute Protocol

Protocol xử lý khiếu nại và bảo hành bảo vệ quyền riêng tư trên Avalanche (Dual-Chain: Fuji C-Chain + Custom Dispute L1).

---

## 1. Thông số mạng Dispute L1 (Avalanche Fuji Testnet)

* **Network Name:** `Dispute L1`
* **RPC URL:** `https://managed-nodes.avax.network/ext/bc/CnnZk7teddWLgqy2BD74T6TDUD6oJJVR3DtZTAspXSDd2xCvz/rpc`
* **WebSocket URL:** `wss://managed-nodes.avax.network/ext/bc/CnnZk7teddWLgqy2BD74T6TDUD6oJJVR3DtZTAspXSDd2xCvz/ws`
* **EVM Chain ID:** `662831` (Hex: `0xa1d2f`)
* **Gas Token:** `DISP` (18 decimals)
* **Avalanche Blockchain ID:** `CnnZk7teddWLgqy2BD74T6TDUD6oJJVR3DtZTAspXSDd2xCvz`
* **Blockchain ID (Bytes32 Hex):** `0x1ac4f03783f66f0733d25e7b8df833da1d739e7b20404cd2cfd867bf1d270539`
* **Subnet ID:** `2uZ9urRdTwnu1LRQtizioDZQj2pvQGpd7NpZPT3WoDWD3PWDio`

---

## 2. Bằng chứng kiểm tra nhanh On-Chain (Quick Verification)

Ban Giám Khảo có thể kiểm tra trực tiếp các giao dịch đã thực thi thành công mà không cần deploy lại:

* **PingSender (Fuji C-Chain):** [`0x82897b63bba2Bab3D43Ed9Ccc4A0EF8321d6d8d6`](https://testnet.snowtrace.io/address/0x82897b63bba2Bab3D43Ed9Ccc4A0EF8321d6d8d6)
* **PongReceiver (Dispute L1):** `0x83620E38fcDF5BF361494932dA91261C006C64d3`
* **Giao dịch Teleporter Ping thành công:** [`0x4c099fd1cf9afed7a8ed83b0f1039a6a6d46a11c8ea255c3b84d7969ed83e0ad`](https://testnet.snowtrace.io/tx/0x4c099fd1cf9afed7a8ed83b0f1039a6a6d46a11c8ea255c3b84d7969ed83e0ad)
  *(Sự kiện `PingSent` mang payload khiếu nại xuyên chuỗi đã được ghi nhận trên block #61104561 và chuyển giao sang Dispute L1).*

---

## 3. Cấu trúc thư mục

```text
project/
├── infra/
│   ├── avalanche-l1/
│   │   ├── network-config.json      # Thông số kết nối Dispute L1
│   │   └── genesis.json             # Cấu hình Genesis của L1
│   └── icm/
│       └── relayer-config.json      # Cấu hình 2 chiều C-Chain <-> Dispute L1
│
├── contracts/                       # Smart contracts (Hardhat)
│   ├── hardhat.config.js            # Cấu hình 2 mạng fuji & disputeL1
│   ├── contracts/
│   │   ├── c-chain/PingSender.sol   # Contract gửi tin Teleporter trên C-Chain
│   │   └── dispute-l1/PongReceiver.sol # Contract nhận tin Teleporter trên L1
│   └── scripts/
│       ├── deploy-ping-pong.js      # Script deploy 2 contract
│       ├── test-ping.js             # Script gửi test cross-chain message
│       └── check-status.js          # Script kiểm tra số dư và contract
│
├── services/
│   └── relayer-monitor/
│       └── relayer.js               # Native Node.js Relayer (chạy không cần Docker)
│
├── .env.example                     # Mẫu biến môi trường
└── README.md
```

---

## 4. Hướng dẫn chạy lại thử nghiệm (Reproduce / Local Run)

### Bước 1: Cài đặt thư viện
```bash
cd project/contracts
npm install

cd ../services/relayer-monitor
npm install
```

### Bước 2: Thiết lập môi trường
Copy file mẫu `.env.example` thành `.env` và điền Private Key có số dư testnet:
```bash
cp .env.example .env
```
*(Điền `PRIVATE_KEY` vào `.env`. Bạn có thể dùng luôn 2 địa chỉ contract đã deploy sẵn ở Mục 2 hoặc tự deploy lại).*

### Bước 3: Deploy lại (Tuỳ chọn)
```bash
cd project/contracts
npm run deploy:fuji
npm run deploy:disputeL1
```

### Bước 4: Khởi động Native Relayer
Mở một cửa sổ terminal riêng và chạy:
```bash
cd project/services/relayer-monitor
node relayer.js
```

### Bước 5: Bắn tin nhắn Teleporter Ping-Pong
Trong thư mục `project/contracts`, chạy:
```bash
npm run ping
```
*Kết quả sẽ hiển thị giao dịch Ping được gửi thành công trên C-Chain, Relayer lập tức bắt event và bàn giao sang PongReceiver trên Dispute L1!*
