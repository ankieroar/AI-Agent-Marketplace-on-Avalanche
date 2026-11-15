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

## 2. Cấu trúc dự án

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
│   ├── hardhat.config.ts            # Cấu hình 2 mạng fuji & disputeL1
│   ├── c-chain/
│   │   └── PingSender.sol           # Contract gửi tin Teleporter trên C-Chain
│   ├── dispute-l1/
│   │   └── PongReceiver.sol         # Contract nhận tin Teleporter trên L1
│   └── scripts/
│       ├── deploy-ping-pong.ts      # Script deploy 2 contract
│       └── test-ping.ts             # Script gửi test cross-chain message
│
├── services/
│   └── relayer-monitor/
│       └── relayer.js               # Native Node.js Relayer (chạy không cần Docker)
│
├── .env.example                     # Mẫu biến môi trường
└── .env                             # File cấu hình bí mật của bạn
```

---

## 3. Hướng dẫn chạy thử nghiệm Ngày 1 (Go / No-Go Test)

### Bước 1: Cấu hình Private Key
Mở file `project/.env` và điền Private Key ví của bạn (ví đã có AVAX trên Fuji và DISP trên Dispute L1):
```ini
PRIVATE_KEY=your_private_key_without_0x_or_with_0x
```

### Bước 2: Deploy Contracts
1. Deploy `PingSender` lên **Fuji C-Chain**:
   ```bash
   cd contracts
   npm run deploy:fuji
   ```
   *Copy địa chỉ contract được in ra và dán vào `PING_SENDER_ADDRESS` trong `.env`.*

2. Deploy `PongReceiver` lên **Dispute L1**:
   ```bash
   npm run deploy:disputeL1
   ```
   *Copy địa chỉ contract được in ra và dán vào `PONG_RECEIVER_ADDRESS` trong `.env`.*

### Bước 3: Khởi động Native Relayer
Mở một cửa sổ terminal riêng và chạy:
```bash
node services/relayer-monitor/relayer.js
```

### Bước 4: Bắn tin nhắn Teleporter Ping-Pong
Trong thư mục `contracts`, chạy:
```bash
npm run ping
```
*Bạn sẽ thấy giao dịch Ping được gửi thành công trên C-Chain, Relayer lập tức bắt event và bàn giao sang PongReceiver trên Dispute L1!*
