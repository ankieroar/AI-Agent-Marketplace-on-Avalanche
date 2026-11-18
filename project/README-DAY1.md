# Ngày 1 — Hướng dẫn chạy

**Kết quả đã kiểm chứng:** xem [DAY1-LATEST-STATUS.md](docs/DAY1-LATEST-STATUS.md). Proof thật đã verify trên L1. Teleporter V2 đã nhận Fuji → L1 và L1 phát pong; L1 → Fuji chưa được xác nhận do validator quảng bá địa chỉ P2P riêng.

## Trạng thái thực tế (kiểm tra ngày 2026-11-17)

Các trạng thái dưới đây phân biệt phần đã kiểm chứng với phần còn chờ.

| Phần | Trạng thái |
| --- | --- |
| PostgreSQL/API/AES, test local | Đã chạy và pass |
| DApp production build | Pass với Node 22; chưa kiểm thử ví trên trình duyệt |
| AI thật | Chưa gọi; OPENROUTER_API_KEY chưa có trong project/.env tại lúc kiểm tra. Test hiện dùng mock |
| Teleporter thật hai chiều | Một vòng V2 đã nhận Fuji → L1 qua Warp thật; L1 tự phát pong. **Chưa nhận pong về Fuji**, chưa đạt hai chiều |
| Noir | Pass 2 test, đã tạo witness |
| Barretenberg/verifier | Native `bb` v0.82.2 lỗi `Illegal instruction` trên máy/Docker CPU hiện tại. Đã dùng `@aztec/bb.js` v0.82.2 WASM thay thế: sinh proof thật, verify local, export verifier 11,037 bytes, deploy và verify proof trên L1 thành công |

Bằng chứng và hash giao dịch: [DAY1-REPORT.md](docs/DAY1-REPORT.md), [icm-roundtrip.json](docs/icm-roundtrip.json). Đây là snapshot lúc kiểm tra, không tự cập nhật theo trạng thái mạng.

## Cài đặt monorepo

Dùng Node.js 22 LTS. Các lệnh PowerShell dùng đường dẫn repo trên máy hiện tại. Nếu clone ở nơi khác, thay tiền tố `D:\26120200\team1_vietnam_unihack` bằng đường dẫn repo của bạn.

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
npm.cmd ci
node apps/api/src/setup-env.mjs
npm.cmd test
```

Nếu lần đầu chạy Hardhat, cài dependencies riêng của contract:

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project\contracts'
npm.cmd ci --workspaces=false
```

Script setup chỉ bổ sung secret ngẫu nhiên chưa tồn tại trong `.env`, không in giá trị. Không commit `.env`. API_ACCESS_TOKEN là token phát triển dùng chung cho backend cục bộ, chưa thay thế xác thực người dùng/ủy quyền từng hồ sơ.

Kế hoạch sản phẩm đã đổi sang curated marketplace: xem [PLAN-UPDATE.md](docs/PLAN-UPDATE.md) và README ở gốc repo. Schema hiện tại vẫn là warranty prototype, chưa phải schema marketplace mới.

## PostgreSQL và API

Docker Desktop phải đang chạy. Docker Desktop có điều kiện license theo tổ chức; PostgreSQL có PostgreSQL License. Không dùng DB cloud trả phí.

**Terminal 1. Khởi động PostgreSQL rồi chạy migration và smoke test.** Docker Compose đọc `project/compose.yaml` và `project/.env` từ thư mục này.

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
docker compose up -d postgres
docker compose ps
npm.cmd run migrate -w @warranty/api
node --env-file=.env tests/storage-smoke.mjs
node --env-file=.env tests/api-smoke.mjs
```

Nếu gặp `no configuration file provided: not found`, chạy lại lệnh `cd` trong khối trên rồi kiểm tra `Get-Item .\compose.yaml`. Nếu PostgreSQL vừa khởi động và chưa nhận kết nối, đợi container sẵn sàng rồi chạy lại migration.

Nếu muốn bật PostgreSQL từ thư mục khác, chỉ rõ file cấu hình:

```powershell
docker compose --env-file 'D:\26120200\team1_vietnam_unihack\project\.env' -f 'D:\26120200\team1_vietnam_unihack\project\compose.yaml' up -d postgres
```

**Terminal 2. Bật API và giữ terminal này mở.**

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
npm.cmd run dev:api
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

**Terminal riêng. Chạy web để xem giao diện.**

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
npm.cmd run dev:web
```

Mở [http://localhost:3000](http://localhost:3000) bằng Chrome có Core hoặc MetaMask. Nếu Next.js hiển thị cổng khác, dùng địa chỉ ở dòng `Local`. Trang Day 1 cho kết nối ví và chuyển Fuji `43113` hoặc Dispute L1 `662831`. Luồng Marketplace nằm trong [README Day 2](README-DAY2.md).

**Kiểm tra production build.** Dừng web dev bằng Ctrl+C trước để hai lệnh dùng thư mục build lần lượt:

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
npm.cmd run build:web
```

## Noir hello-world (Windows và Linux)

Circuit `circuits/hello_world` chứng minh `x + y = z`, trong đó x,y private và z public. Kết quả đã chạy thành công trên Windows với Docker.

**Windows PowerShell.** Mở Docker Desktop. Nếu chưa có Nargo beta.3, tải bản Linux để container chạy, sau đó chạy prover:

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
if (!(Test-Path '.tools/noir/nargo')) {
    New-Item -ItemType Directory -Force .tools/noir | Out-Null
    Invoke-WebRequest 'https://github.com/noir-lang/noir/releases/download/v1.0.0-beta.3/nargo-x86_64-unknown-linux-gnu.tar.gz' -OutFile .tools/noir.tar.gz
    tar -xzf .tools/noir.tar.gz -C .tools/noir
}
cd 'D:\26120200\team1_vietnam_unihack\project\services\prover'
npm.cmd ci --workspaces=false
npm.cmd run day1
```

Docker Desktop cần đang chạy; `prepare-circuit.mjs` gọi Nargo beta.3 bên trong Docker. Sau đó Barretenberg WASM chạy bằng Node trên Windows. `.tools/noir` được mount vào container, không cần cài Linux/WSL riêng.

**Linux hoặc WSL.** Ví dụ dưới đây dùng đường dẫn ổ D trên WSL. Nếu dùng Linux, thay đường dẫn `cd` bằng thư mục `project` trong bản clone:

```bash
cd /mnt/d/26120200/team1_vietnam_unihack/project
bash services/prover/day1.sh
```

Script cài Nargo v1.0.0-beta.3 vào `.tools` nếu chưa có, chạy hai circuit tests và tạo witness; tiếp đó nó chạy `npm ci --workspaces=false` cùng `prove-wasm.mjs` dùng `@aztec/bb.js` v0.82.2. Cần Internet để tải Nargo và SRS công khai. Các file `.tools`, witness, proof và VK được gitignore.

**Phân biệt lỗi bb:** executable native `bb` v0.82.2 từng thoát `Illegal instruction` trong môi trường CPU/Docker này. Đó là lỗi của binary native trên môi trường chạy. Pipeline đã chuyển sang Barretenberg WASM v0.82.2 và chạy thành công; vì vậy không cần native `bb` để làm tiếp. Đây là hai cách chạy backend Barretenberg khác nhau, không phải proof giả hay circuit bị bỏ qua.

Lệnh hoàn tất sẽ in `Valid proof accepted`, `wrongPublicInputRejected: true`, kích thước proof và verifier. Verifier Solidity sinh ra là Apache-2.0; thư viện WASM MIT, license được lưu cạnh verifier. Circuit này chỉ là hello-world, chưa chứng minh policy/refund của marketplace.

**Kiểm tra kích thước verifier local** sau khi sinh proof thành công:

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project\contracts'
node scripts/verifier-size.js
```

**Deploy và kiểm tra trên Dispute L1 (tùy chọn).** Hai lệnh dưới đây có thể gửi giao dịch. Cần cấu hình RPC và ví testnet có gas trong `project/.env`.

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project\contracts'
npx.cmd hardhat run scripts/deploy-verifier.js --network disputeL1
npx.cmd hardhat run scripts/verify-proof.js --network disputeL1
```

`verifier-size.js` báo kích thước deployed bytecode và chặn nếu vượt 24,576 bytes. `deploy-verifier.js` deploy/reuse verifier có bytecode trùng; `verify-proof.js` kiểm tra proof đúng, proof bị sửa và giao dịch verify trên L1. Bằng chứng giao dịch đã chạy được lưu ở `docs/verifier-deployment.json` và `docs/zk-l1-verification.json`.

## Teleporter/ICM: hai bộ test, mục đích khác nhau

Messenger là transport ICM/Warp. App V2 `PingSenderV2`/`PongReceiverV2` xử lý nội dung ping/pong và xác thực chain + peer. Có hợp đồng/event hoặc tổng số tin nhắn tăng **không tự chứng minh** Warp message được xác thực; phải kiểm tra `TeleporterMessenger.messageReceived(messageID)` và receipt giao dịch destination.

### A. Strict demo đời đầu (README trước đây)

Các lệnh này kiểm tra contracts cũ (`TeleporterPingPong`), test, audit cấu hình chain và thử vòng đời relayer đời đầu:

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project\contracts'
npx.cmd hardhat test
node scripts/audit-day1.js
npx.cmd hardhat run scripts/icm-roundtrip.js
```

`npx hardhat test` chỉ chạy local unit tests. `audit-day1.js` là audit RPC/config, không gửi ping. `icm-roundtrip.js` là script cũ; nó dùng `.env` và Fuji test token, có thể gửi giao dịch. Kết quả của nó được lưu ở `docs/icm-roundtrip.json`. Đó là một bộ triển khai tách biệt với V2 bên dưới; đừng dùng snapshot cũ trong `icm-roundtrip.json` để kết luận trạng thái V2 mới nhất.

### B. V2 đã deploy (khuyến nghị để kiểm tra trạng thái hiện tại)

- `npm run icm:check`: **chỉ đọc**, không ký hoặc gửi giao dịch. Kiểm tra round V2 đã lưu: receipt nhận trên L1, Warp predicate, `Messenger.messageReceived`, event app và trạng thái chiều Fuji.
- `npm run icm:roundtrip:api`: có thể **gửi giao dịch testnet** nếu chưa có ping đang chờ. Tiếp tục round V2 đã lưu, xin chữ ký từ API tổng hợp công khai, tự gửi giao dịch nhận tới Messenger rồi thử chiều về. Không cần API key; vẫn cần validator cung cấp đủ chữ ký. API trả HTTP 500 cho chữ ký L1 trong lần thử gần nhất, nên có thể dừng ở chiều về.
- `npm run icm:roundtrip`: official ICM relayer tự host theo P2P, có thể gửi giao dịch testnet sau khi relayer sẵn sàng. Cần kết nối đủ quorum tới validator của cả chain. Validator L1 hiện được discovery quảng bá tại IP riêng `10.146.2.83:9651`, nên chưa đạt điều kiện này.
- `npm run icm:forward`: chạy official relayer chỉ cho Fuji → L1; có thể gửi ping mới nếu không có round pending. Hữu ích để tách chẩn đoán chiều đi.
- `npm run icm:prepare`: compile/deploy V2 nếu thiếu, cấu hình peer và có thể nạp gas testnet từ `PRIVATE_KEY` tới ví relayer mới. Đây là giao dịch có chi phí token testnet.
- `npm run icm:install`: tải binary relayer pinned, kiểm tra checksum và build image Docker; không gửi giao dịch chain.

Round V2 đã kiểm chứng: Fuji ping `0x74bf09996e74516b40f070d0a5f6637f0a330fb7c54af973244f4085368f9747`; L1 receive và tự phát pong `0x8f3e621b98c0acd319a353698c88c44e06cac1d7ea47e4160749198d3dd96722`. L1 Messenger và app đã nhận. Pong chưa nhận tại Fuji; `icm:check` hiện dự kiến cho `fujiMessengerReceived=false`, `fujiApplicationCompleted=false`.

Để chỉ đọc trạng thái round đã gửi:

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project\contracts'
npm.cmd run icm:check
```

Để thử relay bằng API, dùng cùng thư mục `contracts`. Lệnh này có thể gửi giao dịch delivery hoặc tạo ping nếu chưa có round chờ.

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project\contracts'
npm.cmd run icm:roundtrip:api
npm.cmd run icm:check
```

Chỉ kết luận thông hai chiều khi audit xác nhận `fujiMessengerReceived=true` **và** `fujiApplicationCompleted=true`, đồng thời có receipt/event trên Fuji. Xem [README-ICM-SELFHOST.md](README-ICM-SELFHOST.md) và [DAY1-LATEST-STATUS.md](docs/DAY1-LATEST-STATUS.md) để biết nguyên nhân blocker validator. Legacy `fallback-relayer.js` không chứng minh ICM/Warp thật.

## Cấu trúc

`apps/api`: HTTP, migration DB, crypto, cấu hình local. `apps/web`: Next/Tailwind/wagmi. `packages/schema`: schema và commitment. `services/agents`: prompt + adapter miễn phí + pipeline. `services/prover`: toolchain. `circuits/hello_world`: circuit. `contracts`: strict ping-pong/tests/deploy scripts. `infra/avalanche-l1/config.json`: cấu hình công khai và NodeID truy vấn từ P-Chain. `docs`: schema và bằng chứng kiểm thử.
