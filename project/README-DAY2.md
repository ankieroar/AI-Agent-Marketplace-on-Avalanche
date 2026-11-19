# Day 2 · Demo Marketplace, API và ZK

| Muốn thử | Cần chạy |
|---|---|
| Duyệt giao diện, mua, chạy agent, accept hoặc review một dispute giả lập | Next.js |
| Xác thực ví buyer và chạy agent cho order đã thanh toán trên Hardhat | Hardhat node, PostgreSQL, API và Next.js |
| Xác minh proof policy thật, xem bytecode hoặc duyệt dispute bằng proof thật | Noir beta.3, Barretenberg WASM và Hardhat |

Các lệnh dưới đây dùng PowerShell và đường dẫn repo trên máy hiện tại. Nếu clone ở thư mục khác, thay `D:\26120200\team1_vietnam_unihack` bằng đường dẫn repo của bạn. Trên Linux/macOS dùng `npm` và `npx` thay `npm.cmd` và `npx.cmd`.

### Cài dependencies một lần nếu vừa clone

Dùng Node.js 22. Cả hai mục demo cần dependencies trong `project`. Mục 2 cần thêm dependencies trong `project/contracts`.

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
npm.cmd ci

cd 'D:\26120200\team1_vietnam_unihack\project\contracts'
npm.cmd ci --workspaces=false
```

## 1. Xem giao diện

Cách này chỉ cần một terminal. Có thể tắt Docker và Hardhat; không cần kết nối ví hay cài API key.

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
npm.cmd run dev:web
```

Giữ terminal mở. Khi Next.js báo `Ready`, mở [http://localhost:3000/day2](http://localhost:3000/day2) bằng Chrome. Nếu Next.js in cổng khác ở dòng `Local`, dùng cổng đó và thêm `/day2`.

1. Chọn **Demo giả lập → Xem chi tiết → Mua dịch vụ → Chạy agent**.
2. Chọn **Chấp nhận** để xem luồng trả tiền cho seller.
3. Tạo order mới, chạy lại agent rồi chọn **Mở tranh chấp → Phân tích → Duyệt hoàn tiền** hoặc **Từ chối**. Xem các bước trong **Timeline**.

## 2. Test API, PostgreSQL và order Hardhat thật

Docker chạy PostgreSQL. Hardhat chạy chain local, còn API và Next.js chạy trong terminal riêng. Order được ghi trên Hardhat và kết quả được lưu trong PostgreSQL. Phần AI dùng mock ở các bước mặc định bên dưới.

### Terminal 1. Khởi động PostgreSQL và chạy migration

Mở Docker Desktop và đợi Docker chạy. Nếu đã thiết lập Day 1, dùng lại `.env` và volume PostgreSQL.

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
if (!(Test-Path .env)) { node apps/api/src/setup-env.mjs }
docker compose up -d postgres
docker compose ps
npm.cmd run migrate -w @warranty/api
```

Kết quả mong đợi là container PostgreSQL đang chạy và terminal in `Migrations complete`. Nếu migration báo chưa kết nối được, đợi PostgreSQL khởi động rồi chạy lại lệnh migration.

Nếu Docker báo `no configuration file provided: not found`, quay về thư mục `project` bằng lệnh `cd` ở trên rồi kiểm tra `Get-Item .\compose.yaml`. Docker Compose cần file này để tìm service `postgres`.

### Terminal 2. Mở Hardhat node

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project\contracts'
npx.cmd hardhat node
```

Giữ terminal này mở. RPC local là `http://127.0.0.1:8545`, chain ID `31337`.

### Terminal 1. Deploy contract và tạo order demo

Sau khi Hardhat đã khởi động, quay lại terminal 1:

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project\contracts'
npx.cmd hardhat run scripts/day2-prepare-api.js --network localhost
```

Copy giá trị **`paid`** để dán vào giao diện. Script cũng in `buyer`, `disputed` và `caseId`. File địa chỉ và ABI nằm trong `project/.runtime/day2/day2-local.json`. Nếu tắt và bật lại Hardhat, chạy lại lệnh deploy và sử dụng `paid` mới.

### Terminal 3. Chạy backend

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
$env:DAY2_AI_MODE = 'mock'
npm.cmd run dev:api
```

Giữ terminal mở. Mở [http://127.0.0.1:3001/health](http://127.0.0.1:3001/health) để kiểm tra `{"database":"ready"}`.

### Terminal 4. Chạy frontend

Nếu frontend ở Mục 1 vẫn chạy, dùng lại trang đó. Nếu chưa chạy, mở terminal mới:

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
npm.cmd run dev:web
```

Nếu cổng `3000` bị chiếm hoặc tải không được, dừng tiến trình web đang lỗi bằng Ctrl+C trong terminal của nó rồi thử lệnh sau từ cùng thư mục `project`:

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
npm.cmd run dev -w @warranty/web -- --turbopack --port 3004
```

### Kiểm tra từ Chrome

1. Mở [http://localhost:3000/day2](http://localhost:3000/day2), hoặc [http://localhost:3004/day2](http://localhost:3004/day2) nếu chạy bằng cổng dự phòng. Dùng Chrome có extension Core hoặc MetaMask. Trình duyệt nhúng VS Code không dùng được extension ví của Chrome.
2. Chọn **API local**, dán giá trị `paid` từ terminal 1, rồi bấm **Kiểm tra order**. Order mới sẽ hiện **PAID**. Bước này chưa cần ví.
3. Để thử ký, dùng ví test trên **Hardhat Local** với RPC `http://127.0.0.1:8545`, chain ID `31337`. Trong terminal Hardhat, tìm tài khoản mặc định **Account #2** (`0x3C44…93BC`), đối chiếu với `buyer` rồi import tài khoản test vào ví. Chỉ dùng key Hardhat mặc định trên local.
4. Bấm **Kết nối ví buyer**, chọn đúng địa chỉ `buyer`, giữ văn bản mẫu và bấm **Ký và chạy agent**. Core hoặc MetaMask sẽ yêu cầu ký thông điệp. Kết quả tóm tắt và chế độ `mock` sẽ hiện trên trang.

### Kiểm tra backend không cần ví trình duyệt

Chạy trong terminal trống từ `project` sau khi Hardhat, PostgreSQL và API đã sẵn sàng. Dùng fixture mới nếu order đã được chạy với văn bản khác. Script dùng tài khoản Hardhat để kiểm tra đúng/sai buyer, order đang dispute, chạy lại và upload bằng chứng mã hóa.

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
node --env-file=.env tests/day2-api-smoke.mjs
```

Chạy fixture mới trước khi chuyển một order đã có kết quả từ mock sang provider thật. Với cùng order và cùng input, backend trả kết quả đã lưu. Trạng thái `DELIVERED` từ executor là trạng thái lưu ở DB. Seller vẫn gọi `markDelivered` trên chain với `resultHash` nếu cần cập nhật trạng thái contract.

### Seed agent và chính sách service trên staging

Script seed chỉ nhận **checkout thật**: nó đọc order và `policyCommitment` đã ghi bởi `purchaseService` trên chain, tự tính lại commitment BLAKE2s từ witness (cùng thuật toán với circuit Noir), và **dừng nếu hai giá trị không khớp**. Không có đường tắt mock: `DAY2_CHAIN_MODE=mock` bị từ chối.

```powershell
cd project
npm.cmd run migrate -w @warranty/api
npm.cmd run seed:staging
```

Trước khi chạy, cần có manifest + fixture do `scripts/day2-prepare-api.js` tạo trong `.runtime/day2/`, policy witness `.runtime/day2/day2-mock-policy.json`, và `DATABASE_URL`/`AES_KEY_HEX` trong `project/.env`. Với staging, trỏ `DAY2_RPC_URL` và `DAY2_CONTRACTS_FILE`/`DATABASE_URL` sang môi trường staging bằng account quyền tối thiểu; không commit `.env`. Nếu DB remote cần TLS, thêm `?sslmode=require` vào `DATABASE_URL`. Account ứng dụng chỉ cần `SELECT`/`INSERT`/`UPDATE` trên ba bảng seed; chạy migration bằng account sở hữu schema.

Trước khi ghi, seed kiểm tra:

- kết nối DB và sự tồn tại của `service_orders`/`service_policies` (thiếu bảng thì báo chạy migration);
- `policyCommitment` on-chain khớp witness, listing cùng version/giá/cửa sổ khiếu nại, và `claimDeadline = purchaseTimestamp + disputeWindow`;
- nếu đặt `SEED_BACKEND_URL` (hoặc `--backend-url`), gọi `GET /health` và yêu cầu `{"database":"ready"}`;
- nếu truyền `--tx-hash`, tải receipt và xác nhận log `ServicePurchased` đúng order, commitment, buyer, seller, giá và timestamp. Hash không khớp bị từ chối, không được ghi vào receipt như bằng chứng giả.

Seed ghi ba bảng trong một transaction:

- `agent_listings_cache`: listing active đọc từ `AgentRegistry`.
- `service_orders`: snapshot order đã confirmed, kèm commitment và timestamp từ checkout.
- `service_policies`: witness (`disputeWindow`, `maxRefund`, `nonce`) mã hóa AES-256-GCM với AAD `service-policy:<orderId>`, cùng commitment/version. Một order chỉ có một policy; seed lại với commitment khác sẽ bị từ chối.

Mặc định script lấy order `paid` trong `day2-api-fixture.json`. Có thể chỉ định rõ:

```powershell
# Chỉ kiểm tra chain + commitment, không cần DB
node --env-file=.env apps/api/src/seed-staging.mjs --dry-run

# Kiểm tra DB, backend /health và chain trước khi seed thật
node --env-file=.env apps/api/src/seed-staging.mjs --check

# Seed với order và tx hash cụ thể
node --env-file=.env apps/api/src/seed-staging.mjs --order-id 0x... --tx-hash 0x...
```

`--dry-run` chỉ đọc chain và kiểm tra commitment; `--check` kiểm tra thêm kết nối DB, schema và backend nhưng không ghi. Các tùy chọn khác: `--agent-id`, `--policy`, `--manifest`, `--fixture`, `--backend-url`, `--receipt`. Biến môi trường tương ứng: `SEED_ORDER_ID`, `SEED_AGENT_ID`, `SEED_POLICY_FILE`, `SEED_FIXTURE_FILE`, `SEED_CHECKOUT_TX_HASH`, `SEED_BACKEND_URL`. Receipt công khai (không chứa witness) được ghi ở `.runtime/day2/seed-staging.json`.

Kiểm thử phần kiểm tra commitment và mã hóa mà không cần DB/chain:

```powershell
npm.cmd run test:seed
```

### Bật AI thật bằng OpenRouter Free

Đặt `OPENROUTER_API_KEY` trong `project/.env`. Dùng `OPENROUTER_MODEL=openrouter/free` hoặc một model có hậu tố `:free`. Adapter chỉ gửi yêu cầu giá bằng 0, có thể trả lỗi quota nếu model miễn phí hết lượt. Dùng tài liệu và hóa đơn giả lập để demo. [OpenRouter Free Models](https://openrouter.ai/collections/free-models/)

Trong UI Day 2, khung **Chat với AI** gọi endpoint `POST /api/day2/chat` qua backend. Chạy PostgreSQL, migration và API như mục 2, rồi mở trang Day 2. Chat không cần ví, nhưng cần `OPENROUTER_API_KEY` trong `project/.env` và phải khởi động lại API sau khi thêm key. Chọn **API local** nếu cần kiểm tra order. Khung chat gọi OpenRouter thật ở cả hai chế độ giao diện.

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
node --env-file=.env tests/day2-ai-live.mjs
node --env-file=.env tests/day2-ai-live.mjs --pipeline
```

Lệnh đầu gọi Document Summary Agent. Lệnh thứ hai gọi thêm Evidence → Policy → Resolution. Kết quả được kiểm tra schema, và đề xuất hoàn tiền của AI chỉ dành cho reviewer. Muốn dùng provider thật trong UI, khởi động lại API với `DAY2_AI_MODE=openrouter`, tạo fixture mới và chọn **API local**. Giữ API key ở server.

Để kiểm tra schema và các lỗi mô phỏng mà không dùng quota, chạy `node --test tests/core.test.mjs tests/day2-agents.test.mjs`.

## 3. Tạo và kiểm thử proof policy thật

Nếu chưa có Noir beta.3 trong `.tools/noir` và dependencies của prover, làm theo phần ZK trong [README Day 1](README-DAY1.md). Trên Windows, mở Docker Desktop để script chạy trình biên dịch Linux trong container. Trên Linux, script dùng nargo đã pin hoặc nargo beta.3 trong PATH.

Với checkout mới trên Windows, có thể cài Nargo cho Docker và dependencies của prover từ `project`:

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
New-Item -ItemType Directory -Force .tools/noir | Out-Null
Invoke-WebRequest https://github.com/noir-lang/noir/releases/download/v1.0.0-beta.3/nargo-x86_64-unknown-linux-gnu.tar.gz -OutFile .tools/noir.tar.gz
tar -xzf .tools/noir.tar.gz -C .tools/noir
npm.cmd ci --prefix services/prover --workspaces=false
```

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
node services/prover/day2.mjs
cd contracts
npx.cmd hardhat test
```

Kết quả mong đợi gồm từ chối claim quá hạn, refund vượt trần và case bị sửa. Proof hợp lệ được WASM và Solidity verifier chấp nhận. Solidity test so sánh toàn bộ 15 public inputs với ProofGate, rồi sửa refund/case để xác nhận verifier từ chối. Bytecode triển khai đo được **11.036 bytes**. WASM dùng `@aztec/bb.js@0.82.2`, thay cho native `bb` đang lỗi `Illegal instruction`. Mạng Dispute L1 đã có [kết quả kiểm tra verifier Hello World Day 1](docs/zk-l1-verification.json). Policy verifier Day 2 đã kiểm tra trên Hardhat.

### Tạo proof từ case vừa mở trên Hardhat

Giữ node và fixture ở mục 2. Từ `project`:

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
$fixture = Get-Content .runtime/day2/day2-api-fixture.json -Raw | ConvertFrom-Json
$proof = node --env-file=.env apps/api/src/prove-case.mjs $fixture.caseId 5000000000000000 .runtime/day2/day2-mock-policy.json
if ($LASTEXITCODE -ne 0) { throw 'Tạo proof thất bại' }
Set-Content -Encoding ascii .runtime/day2/day2-case-proof.json $proof
cd contracts
npx.cmd hardhat run scripts/day2-settle-api.js --network localhost
```

Script reviewer dùng proof thật để duyệt hoàn **0,005 AVAX mô phỏng**, chuyển message kết quả bằng mock messenger local và in order status `5` (`Resolved`). File policy do fixture tạo chỉ dùng local. Prover đọc claim/order từ chain, đối chiếu commitment với policy do bên vận hành cung cấp, rồi trả proof và public inputs. Witness tạm được dọn sau khi chạy.

## 4. Cấu trúc và dữ liệu bàn giao

- `circuits/service_policy`, `services/prover/` giữ circuit, chuẩn lập commitment và prover. Commitment dùng BLAKE2s với domain, orderId, policy version, cửa sổ khiếu nại, maxRefund và nonce riêng 128 bit. Mốc mua và hạn khiếu nại lấy từ chain, circuit kiểm tra chúng khớp với cửa sổ đã commit. Refund dùng số nguyên u64 theo wei. Nullifier gắn với case, order và source blockchain. DisputeManager chặn dùng lại nullifier.
- `apps/api/migrations/002-day2.sql` thêm cache listing, orders, cases và agent outputs, mở rộng evidence. `003-service-policies.sql` thêm witness policy riêng tư theo order (mã hóa, commitment khớp checkout). Bằng chứng và kết quả được mã hóa AES-256-GCM với IV ngẫu nhiên và auth tag cho từng bản ghi. `apps/api/src/seed-staging.mjs` seed agent + policy từ checkout thật để phục vụ staging.
- `apps/api/src/day2-routes.mjs` cung cấp `GET /api/agents`, `GET /api/orders/:id`, `POST /api/orders/:id/execute`, `POST /api/cases/upload` và `POST /api/cases/:id/prepare-proof` (tạo proof từ policy đã mã hóa cho reviewer nộp qua ví). Hai POST ký EIP-191 qua ví, ràng buộc scope chain/contract, thao tác, ID, hạn chữ ký và SHA-256 của JSON body. API xác minh trạng thái order và buyer từ chain. Executor dùng khóa theo order trong PostgreSQL, lease cho tác vụ lỗi và rate limit theo ví. Chế độ mock chain chỉ dùng khi bật rõ ràng với `DAY2_CHAIN_MODE=mock` và `DAY2_MOCK_BUYER`.
- `services/agents` xử lý OpenRouter Free, kiểm tra JSON và báo lỗi timeout, quota hoặc output sai schema. `apps/web/app/day2` chứa UI demo và màn hình chạy agent với order Hardhat. API key và dữ liệu policy riêng để ở server.
- [Demo contract của Người 1](docs/DAY2-NGUOI1-DEMO.md) mô tả ABI, event và thứ tự public inputs. Teleporter chiều về trên Fuji vẫn để xử lý sau. Các bước trong tài liệu này chạy local.
