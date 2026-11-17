# Ngày 1 — Hướng dẫn chạy

## Cài đặt monorepo

Từ thư mục `project`, dùng Node 22 LTS để tránh cảnh báo engine từ dependency ví:

```powershell
npm ci
node apps/api/src/setup-env.mjs
npm test
```

Script setup chỉ bổ sung secret ngẫu nhiên chưa tồn tại trong `.env`, không in giá trị. Không commit `.env`. API_ACCESS_TOKEN là token phát triển dùng chung cho backend cục bộ, chưa thay thế xác thực người dùng/ủy quyền từng hồ sơ.

Kế hoạch sản phẩm đã đổi sang curated marketplace: xem [PLAN-UPDATE.md](docs/PLAN-UPDATE.md) và README ở gốc repo. Schema hiện tại vẫn là warranty prototype, chưa phải schema marketplace mới.

## PostgreSQL và API

Docker Desktop phải đang chạy. Docker Desktop có điều kiện license theo tổ chức; PostgreSQL có PostgreSQL License. Không dùng DB cloud trả phí.

```powershell
docker compose up -d postgres
npm run migrate -w @warranty/api
node --env-file=.env tests/storage-smoke.mjs
node --env-file=.env tests/api-smoke.mjs
npm run dev:api
```

`GET http://127.0.0.1:3001/health` trả 200 khi DB sẵn sàng, 503 khi chưa kết nối. Các route còn lại yêu cầu `Authorization: Bearer <API_ACCESS_TOKEN>`.

- `POST /evidence` với `{ "text": "hoa don gia lap" }`: trả ID, chỉ lưu JSON đã mã hóa AES-256-GCM trong DB.
- `GET /evidence/<id>`: xác thực token rồi giải mã. AAD ràng buộc ciphertext với ID.
- `POST /pipeline`: nhận `{text,policy:{purchaseTimestamp,warrantyEndTimestamp,maxPayout,nonce},claimTimestamp}`; trả evidence, analysis, resolution.

API chỉ bind localhost, không bật CORS công khai, giới hạn body 64KB. Đây là backend foundation, chưa có đăng nhập ví, ACL theo chủ hồ sơ hoặc giới hạn số request; không mở công khai trước khi bổ sung.

## AI miễn phí

Tự tạo OpenRouter key ở https://openrouter.ai/settings/keys, không nạp credit. Thêm `OPENROUTER_API_KEY` vào `project/.env`. Không đưa key vào NEXT_PUBLIC_* hoặc frontend. `OPENROUTER_MODEL=openrouter/free` mặc định; chỉ cho phép router này hoặc slug kết thúc `:free`. Không có fallback model trả phí. Hết quota hoặc JSON sai thì request lỗi, không tiếp tục quyết định bằng kết quả chưa kiểm chứng.

Tài liệu: https://openrouter.ai/collections/free-models/ . Quota miễn phí có thể thay đổi. Ba agent cần tối thiểu ba request/hồ sơ. Test `npm test` dùng mock, không tiêu quota; mock không phải bằng chứng LLM thật đã chạy.

## DApp

```powershell
npm run dev:web
npm run build:web
```

Mở localhost:3000, kết nối ví extension, chuyển Fuji 43113 hoặc Dispute L1 662831. Không cần WalletConnect key trả phí. Khung UI chưa mở case/giải ngân vì core contracts thuộc bước sau.

## Noir hello-world

`circuits/hello_world` chứng minh x+y=z với x,y private và z public. Chạy script trong Linux có curl/tar/gzip; script cài binary vào `.tools` được gitignore:

```bash
bash services/prover/day1.sh
```

Pin Noir v1.0.0-beta.3 và BB v0.82.2 cho giao diện `bb contract`; không trộn với CLI mới dùng `write_solidity_verifier`. Cần mạng tải GitHub và SRS. Đọc license của các release trước khi phân phối; chưa có phí dịch vụ phát sinh từ script. Không có verifier giả khi tải/sinh proof thất bại.

Trong phiên này nargo đã chạy test và execute thành công, nhưng native bb lỗi `Illegal instruction` ở Docker VM. Script trên chưa chạy trọn vẹn trên máy hiện tại. Cần máy Linux/WSL có CPU tương thích hoặc backend WASM đã kiểm chứng trước khi tiếp tục. Không chạy script deploy-verifier khi chưa sinh artifact thật.

Sau khi sinh verifier thật:

```powershell
cd contracts
node scripts/verifier-size.js
npx hardhat run scripts/deploy-verifier.js --network disputeL1
```

Script kích thước chặn >24576 bytes; deployment lưu tx vào docs. Kiểm thử verify thật vẫn cần proof đúng định dạng/public inputs của đúng BB version; không xem deploy thành công là proof verified.

## Teleporter thật hai chiều

```powershell
cd contracts
npx hardhat test
node scripts/audit-day1.js
npx hardhat run scripts/icm-roundtrip.js
```

Roundtrip dùng PRIVATE_KEY trong `.env` và token testnet. Nó deploy strict receiver ở hai chain, khóa peer, gửi chiều thứ nhất; cần relayer ICM/AWM thật. Nếu báo WAITING thì cấu hình/khôi phục relayer Builder Hub rồi chạy lại; script giữ source hash/message ID để không gửi lại tùy tiện. Chỉ gửi chiều ngược khi chiều trước được chứng minh. Kết quả lưu tại `docs/icm-roundtrip.json`; chỉ `verified:true` cả hai chiều mới đạt mục tiêu.

Daemon `services/relayer-monitor/relayer.js` cũ là fallback, không thể giao tới strict receiver mới. Dừng daemon cũ khi demo ICM thật để tránh nhầm kết quả.

Không tự động deploy lại Messenger vì đã có bytecode ở cả hai chain; cần xác minh đúng version và registry trước. Upstream ICM mới dùng LicenseRef-Ecosystem: https://github.com/ava-labs/icm-contracts/blob/main/LICENSE . Việc có bytecode không chứng minh tương thích hay delivery.

## Cấu trúc

`apps/api`: HTTP, migration DB, crypto, cấu hình local. `apps/web`: Next/Tailwind/wagmi. `packages/schema`: schema và commitment. `services/agents`: prompt + adapter miễn phí + pipeline. `services/prover`: toolchain. `circuits/hello_world`: circuit. `contracts`: strict ping-pong/tests/deploy scripts. `infra/avalanche-l1/config.json`: cấu hình công khai và NodeID truy vấn từ P-Chain. `docs`: schema và bằng chứng kiểm thử.
