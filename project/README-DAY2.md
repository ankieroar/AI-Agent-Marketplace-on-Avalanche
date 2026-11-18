# Day 2 · Demo Marketplace, API và ZK

| Muốn thử | Cần chạy |
|---|---|
| Duyệt giao diện, mua, chạy agent, accept hoặc review một dispute giả lập | Next.js |
| Xác thực ví buyer và chạy agent cho order đã thanh toán trên Hardhat | Hardhat node, PostgreSQL, API và Next.js |
| Xác minh proof policy thật, xem bytecode hoặc duyệt dispute bằng proof thật | Noir beta.3, Barretenberg WASM và Hardhat |

Các lệnh PowerShell dưới đây chạy từ `project` trừ khi ghi rõ. Trên Linux/macOS dùng `npm` và `npx` thay `npm.cmd` và `npx.cmd`.

Nếu vừa clone repo, dùng Node.js 22 rồi chạy `npm.cmd ci` trong `project` và `npm.cmd ci --workspaces=false` trong `project/contracts`.

## 1. Xem giao diện ngay

```powershell
npm.cmd run dev:web
```

Mở [http://localhost:3000/day2](http://localhost:3000/day2). Chọn **Demo giả lập → Xem chi tiết → Mua dịch vụ → Chạy agent**. Chọn **Chấp nhận** để thử trả seller. Tạo order mới để thử **Mở tranh chấp → Phân tích → Duyệt hoàn tiền** hoặc **Từ chối** trong màn hình reviewer. Timeline hiển thị các bước vừa thực hiện. Chế độ này dùng dữ liệu trong trình duyệt nên chạy được khi Docker tắt.

## 2. Test API, PostgreSQL và order Hardhat thật

Nếu chưa có `.env` local, chạy `node apps/api/src/setup-env.mjs`. Nếu đã làm Day 1, dùng lại `.env` và volume PostgreSQL.

```powershell
docker compose up -d postgres
npm.cmd run migrate -w @warranty/api
```

Mở một terminal trong `project/contracts` và giữ node chạy:

```powershell
npx.cmd hardhat node
```

Ở terminal thứ hai, vẫn trong `project/contracts`:

```powershell
npx.cmd hardhat run scripts/day2-prepare-api.js --network localhost
```

Script dùng tài khoản test Hardhat để tạo một order `PAID` và một case `DISPUTED`. Nó in `paid`, `caseId`, `buyer` và cập nhật ABI/địa chỉ trong `.runtime/day2/day2-local.json`. Mỗi lần chạy tạo fixture mới.

Từ `project`, chạy API ở terminal riêng. Để test offline, đặt chế độ AI mock trước:

```powershell
$env:DAY2_AI_MODE = 'mock'
npm.cmd run dev:api
```

Mở [http://127.0.0.1:3001/health](http://127.0.0.1:3001/health) để thấy `{"database":"ready"}`. Sau khi mở web, chọn **API local**, dán ID `paid`, bấm **Kiểm tra order**. Để chạy agent qua trình duyệt, dùng ví test riêng, chọn/tạo mạng Hardhat Local (`http://127.0.0.1:8545`, chain ID `31337`) và nhập tài khoản Hardhat có địa chỉ trùng `buyer`. Chỉ dùng key Hardhat mặc định trên local. Bấm **Ký và chạy agent**, xác nhận chữ ký và xem kết quả. `mock` hiển thị kết quả mẫu và vẫn thực thi kiểm tra buyer, trạng thái thanh toán và ghi PostgreSQL thật.

Để kiểm thử giao diện và API độc lập, có thể bỏ bước import ví và chạy lệnh sau từ `project`. Script ký qua tài khoản Hardhat đã mở khóa và kiểm tra cả trường hợp sai ví, order đang dispute, chạy lại và upload bằng chứng mã hóa:

```powershell
node --env-file=.env tests/day2-api-smoke.mjs
```

Chạy fixture mới trước khi chuyển một order đã có kết quả từ mock sang provider thật. Với cùng order và cùng input, backend trả kết quả đã lưu. Trạng thái `DELIVERED` từ executor là trạng thái lưu ở DB. Seller vẫn gọi `markDelivered` trên chain với `resultHash` nếu cần cập nhật trạng thái contract.

### Bật AI thật bằng OpenRouter Free

Đặt `OPENROUTER_API_KEY` trong `project/.env`. Dùng `OPENROUTER_MODEL=openrouter/free` hoặc một model có hậu tố `:free`. Adapter chỉ gửi yêu cầu giá bằng 0, có thể trả lỗi quota nếu model miễn phí hết lượt. Dùng tài liệu và hóa đơn giả lập để demo. [OpenRouter Free Models](https://openrouter.ai/collections/free-models/)

```powershell
node --env-file=.env tests/day2-ai-live.mjs
node --env-file=.env tests/day2-ai-live.mjs --pipeline
```

Lệnh đầu gọi Document Summary Agent. Lệnh thứ hai gọi thêm Evidence → Policy → Resolution. Kết quả được kiểm tra schema, và đề xuất hoàn tiền của AI chỉ dành cho reviewer. Muốn dùng provider thật trong UI, khởi động lại API với `DAY2_AI_MODE=openrouter`, tạo fixture mới và chọn **API local**. Giữ API key ở server.

Để kiểm tra schema và các lỗi mô phỏng mà không dùng quota, chạy `node --test tests/core.test.mjs tests/day2-agents.test.mjs`.

## 3. Tạo và kiểm thử proof policy thật

Nếu chưa có Noir beta.3 trong `.tools/noir` và dependencies của prover, làm theo phần ZK trong [README Day 1](README-DAY1.md). Trên Windows, mở Docker Desktop để script chạy trình biên dịch Linux trong container. Trên Linux, script dùng nargo đã pin hoặc nargo beta.3 trong PATH.

Với checkout mới trên Windows, có thể cài Nargo cho Docker và dependencies của prover từ `project`:

```powershell
New-Item -ItemType Directory -Force .tools/noir | Out-Null
Invoke-WebRequest https://github.com/noir-lang/noir/releases/download/v1.0.0-beta.3/nargo-x86_64-unknown-linux-gnu.tar.gz -OutFile .tools/noir.tar.gz
tar -xzf .tools/noir.tar.gz -C .tools/noir
npm.cmd ci --prefix services/prover --workspaces=false
```

```powershell
node services/prover/day2.mjs
cd contracts
npx.cmd hardhat test
```

Kết quả mong đợi gồm từ chối claim quá hạn, refund vượt trần và case bị sửa. Proof hợp lệ được WASM và Solidity verifier chấp nhận. Solidity test so sánh toàn bộ 15 public inputs với ProofGate, rồi sửa refund/case để xác nhận verifier từ chối. Bytecode triển khai đo được **11.036 bytes**. WASM dùng `@aztec/bb.js@0.82.2`, thay cho native `bb` đang lỗi `Illegal instruction`. Mạng Dispute L1 đã có [kết quả kiểm tra verifier Hello World Day 1](docs/zk-l1-verification.json). Policy verifier Day 2 đã kiểm tra trên Hardhat.

### Tạo proof từ case vừa mở trên Hardhat

Giữ node và fixture ở mục 2. Từ `project`:

```powershell
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
- `apps/api/migrations/002-day2.sql` thêm cache listing, orders, cases và agent outputs, mở rộng evidence. Bằng chứng và kết quả được mã hóa AES-256-GCM với IV ngẫu nhiên và auth tag cho từng bản ghi.
- `apps/api/src/day2-routes.mjs` cung cấp `GET /api/agents`, `GET /api/orders/:id`, `POST /api/orders/:id/execute` và `POST /api/cases/upload`. Hai POST ký EIP-191 qua ví, ràng buộc scope chain/contract, thao tác, ID, hạn chữ ký và SHA-256 của JSON body. API xác minh trạng thái order và buyer từ chain. Executor dùng khóa theo order trong PostgreSQL, lease cho tác vụ lỗi và rate limit theo ví. Chế độ mock chain chỉ dùng khi bật rõ ràng với `DAY2_CHAIN_MODE=mock` và `DAY2_MOCK_BUYER`.
- `services/agents` xử lý OpenRouter Free, kiểm tra JSON và báo lỗi timeout, quota hoặc output sai schema. `apps/web/app/day2` chứa UI demo và màn hình chạy agent với order Hardhat. API key và dữ liệu policy riêng để ở server.
- [Demo contract của Người 1](docs/DAY2-NGUOI1-DEMO.md) mô tả ABI, event và thứ tự public inputs. Teleporter chiều về trên Fuji vẫn để xử lý sau. Các bước trong tài liệu này chạy local.
