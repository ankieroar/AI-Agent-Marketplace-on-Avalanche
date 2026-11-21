# AI Marketplace & Dispute Protocol

Marketplace dịch vụ AI có escrow và cơ chế khiếu nại. Buyer trả phí khi mua Document Summary. Seller ký quote và xác nhận bàn giao. Khi có tranh chấp, Reviewer ký quyết định và contract xác minh ZK proof trước khi cho phép hoàn tiền.

**Mạng của bản bàn giao** là Avalanche Fuji C-Chain, ID `43113`. Marketplace, escrow, dispute và verifier chạy trên cùng C-Chain. Hardhat `31337` dùng để thử local. **Tính năng tranh chấp qua Custom Dispute L1 và Teleporter hai chiều tạm thời chưa khả dụng.** Code contract, relayer, cấu hình và các bài test tương ứng được giữ cho phần mở rộng.

## 1. Chuẩn bị

Cần Node.js 22 trở lên, npm, Docker Desktop cho PostgreSQL và Core extension trên trình duyệt. Prover chạy Noir và Barretenberg bằng WASM trong Node.js. Lần chứng minh đầu có thể cần Internet để tải CRS. OpenRouter cần API key server-side để chạy AI thật.

Mở PowerShell tại thư mục gốc của repo:

```powershell
Set-Location project
npm.cmd ci
npm.cmd --prefix contracts ci
npm.cmd --prefix services/prover ci
node apps/api/src/setup-env.mjs
```

Script tạo các biến còn thiếu trong `project/.env` và giữ cấu hình đã có. Nếu bạn đã sao chép `.env.example`, điền giá trị thật thay cho placeholder. Các biến cần dùng:

| Biến | Giá trị |
| --- | --- |
| `DATABASE_URL` | Kết nối PostgreSQL. Mặc định cài mới dùng user, database `warranty` và cổng `5432`. |
| `POSTGRES_PASSWORD` | Mật khẩu PostgreSQL của volume Compose. |
| `AES_KEY_HEX` | 64 ký tự hex. Giữ nguyên khi dùng lại database đã có dữ liệu mã hóa. |
| `API_ACCESS_TOKEN` | Token server cho nhóm API cũ. Ví ký các thao tác marketplace. |
| `OPENROUTER_API_KEY` | API key của OpenRouter. |
| `OPENROUTER_MODEL` | `openrouter/free` hoặc model có hậu tố `:free`. |
| `DAY2_AI_MODE` | `openrouter` để chạy tóm tắt thật. `mock` dành cho test tóm tắt offline. |

Mọi lệnh ở các phần sau chạy từ `project`, trừ đoạn chỉ rõ `contracts`.

```powershell
docker compose up -d postgres
docker compose ps
npm.cmd run migrate -w @warranty/api
```

Khi thành công, migration in `Migrations complete`. Nếu dùng volume PostgreSQL cũ, `POSTGRES_PASSWORD` chỉ có tác dụng lúc khởi tạo volume. Với database bạn đã cấu hình riêng như `warranty_migrated`, migration dùng chính `DATABASE_URL` đó.

## 2. Chạy thử local

Giữ ba terminal chạy Hardhat, API và web trong suốt phiên thử.

**Terminal 1 — Hardhat**

```powershell
Set-Location contracts
npx.cmd hardhat node
```

**Terminal 2 — triển khai contract local**

```powershell
Set-Location contracts
$env:DAY2_RPC_URL = 'http://127.0.0.1:8545'
npx.cmd hardhat run scripts/day3-prepare-local.js --network localhost
```

Script đăng ký listing mẫu, in ba địa chỉ và ghi `.runtime/day2/day2-local.json` cho cả web và API. Nếu khởi động lại Hardhat, chạy lại lệnh triển khai rồi tải lại trang. Dùng các order và quote mới sau khi reset chain.

**Terminal 3 — API**

```powershell
$env:DAY2_CHAIN_MODE = 'local'
$env:DAY2_RPC_URL = 'http://127.0.0.1:8545'
$env:DAY2_CONTRACTS_FILE = (Resolve-Path '.runtime/day2/day2-local.json').Path
$env:DAY3_L1_MANIFEST = $env:DAY2_CONTRACTS_FILE
$env:DAY2_AI_MODE = 'openrouter'
npm.cmd run dev:api
```

Mở `http://127.0.0.1:3001/health`. Kết quả mong đợi là `{"database":"ready"}`. Kiểm tra `http://127.0.0.1:3001/api/agents` để xác nhận API đọc được listing từ contract. Web dùng API cổng `3001`.

**Terminal 4 — web**

```powershell
npm.cmd run dev:web
```

Mở `http://localhost:3000`, kết nối **Core**, bấm **Local (31337)**. Nếu Core chưa có mạng, bấm **Thêm Hardhat vào ví** hoặc thêm trong **Core → Settings → Networks** với RPC `http://127.0.0.1:8545`, Chain ID `31337`, ký hiệu `ETH`. Dùng tài khoản Hardhat **#1 Seller**, **#2 Buyer**, **#3 Reviewer**. Chỉ import các khóa Hardhat do terminal in vào profile thử local. Các khóa mặc định này là công khai.

## 3. Triển khai Fuji để nhiều máy dùng chung

| Thông số | Giá trị |
| --- | --- |
| Mạng | Avalanche Fuji C-Chain |
| EVM Chain ID | `43113` |
| RPC | `https://api.avax-test.network/ext/bc/C/rpc` |
| Avalanche Blockchain ID | `yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp` |
| Gas | AVAX testnet |
| Explorer | [Snowtrace Fuji](https://testnet.snowtrace.io/) |

1. Mỗi thành viên dùng ví Core riêng. Lấy **địa chỉ công khai** của Seller và Reviewer rồi điền `DAY3_SELLER` và `DAY3_REVIEWER` trong `project/.env`. Buyer dùng địa chỉ khác Seller. Ví Deployer, Seller, Buyer và Reviewer cần AVAX testnet cho các giao dịch tương ứng. Đặt `PRIVATE_KEY` của Deployer testnet trong `.env`.
2. Dùng PowerShell chạy lệnh sau. Script triển khai contract cùng chain, cấu hình peer nội bộ, cấp quyền Seller và ghi địa chỉ, ABI cùng receipt deploy vào `deployments/fuji-only/`. Giữ các manifest sau khi deploy để lần chạy tiếp theo dùng lại đúng bộ contract.

```powershell
Set-Location contracts
npx.cmd hardhat run scripts/deploy-day3-fuji-only.js --network fuji
```

3. Mở **hai terminal trong `project`**. Trong **mỗi terminal**, dot-source cấu hình trước khi chạy lệnh của terminal đó.

```powershell
. .\scripts\use-day3-fuji.ps1
```

| Terminal | Lệnh |
| --- | --- |
| API | `npm.cmd run dev:api` |
| Web | `npm.cmd run dev:web` |

Nếu dùng production build, chạy `npm.cmd run build:web` sau khi dot-source rồi dùng `npm.cmd exec -w @warranty/web -- next start`. Các địa chỉ `NEXT_PUBLIC_*` được đưa vào bundle lúc build. Chạy API và web trên cùng host vì Next proxy gọi `127.0.0.1:3001`. Để các máy khác truy cập, phục vụ **web** qua một URL HTTPS dành cho nhóm. Giữ API, PostgreSQL và secret trên host. Thành viên kết nối Core và chọn **Fuji (43113)**.

4. Ví Seller được duyệt vào tab **Seller** và bấm đăng ký **Document Summary** nếu chưa có listing. Site dùng một listing mặc định với `agentId = keccak256("document-summary")`. Đọc các địa chỉ contract và ABI tại `deployments/fuji-only/runtime.json` sau khi deploy. Mỗi đơn có `orderId` riêng và mỗi khiếu nại có `caseId` riêng, lấy từ giao dịch mua và mở tranh chấp.

## 4. Vận hành marketplace

| Vai | Thao tác |
| --- | --- |
| Seller | Chọn listing, nhập địa chỉ Buyer, **Ký EIP-712 Quote**. Chuyển quote JSON nếu Buyer ở trình duyệt khác. |
| Buyer | **Dán quote JSON**, mua đúng giá rồi chọn đơn trong **Dịch vụ đã mua → Mở AI**. Ký chạy tóm tắt hoặc mở kết quả đã lưu trong workspace `/day2`, sau đó có thể hỏi đáp theo đơn. Gửi Order ID và Result hash cho Seller. |
| Seller | Tra Order ID, dùng Result hash để **Mark Delivered**. |
| Buyer | Tra lại order. **Chấp nhận** để escrow ghi có cho Seller, hoặc **Mở tranh chấp** trong thời hạn và **Ký & gửi bằng chứng**. |
| Reviewer | Tra Case ID, **Bắt đầu phân tích**. Có thể chạy ba Dispute Agents với nội dung bằng chứng để lấy khuyến nghị. Nhập số wei hoàn tiền, **Tạo proof bằng WASM**, **Nộp Proof**, rồi **Chuyển vào Merchant Review** và ký duyệt hoặc từ chối. Dùng **Gửi phán quyết tới escrow** để áp dụng quyết định. |
| Người nhận tiền | Mở phần số dư escrow, **Làm mới số dư** rồi **Withdraw** bằng ví của mình. |

Trong workspace AI, nút **Về đơn hàng** mở lại đúng Order ID trên `/day3`. Mỗi lượt hỏi dùng chữ ký của Buyer và dữ liệu của đơn đã xác nhận. Lịch sử chat nằm trong phiên hiện tại. Nếu danh sách chưa có đơn cũ, Buyer có thể tra cứu theo Order ID để thêm đơn vào danh sách.

Role do địa chỉ ví và contract quyết định. Phần **Tạo proof bằng WASM** đọc witness mã hóa từ PostgreSQL, đối chiếu với commitment lúc mua và dùng 15 public inputs. ProofGate và Solidity verifier quyết định proof có hợp lệ hay không. Người review chịu trách nhiệm về quyết định. Khuyến nghị AI có thể sai. Reviewer có thể từ chối mà không cần proof hợp lệ. Ví dụ với giá `0.01 AVAX`, số hoàn thử `5000000000000000 wei` là `0.005 AVAX`. Server trả số tiền thực sự được chứng minh sau khi đối chiếu giới hạn policy và escrow.

Sau cửa sổ khiếu nại, dùng **Quyết toán đơn quá hạn** cho đơn còn `Paid` hoặc `Delivered`. Với đơn dịch vụ, escrow ghi có cho Buyer nếu chưa bàn giao, hoặc cho Seller nếu đã bàn giao.

Worker phân tích tự động là tùy chọn. Để chạy trên Fuji với Reviewer vẫn ký trong Core, dot-source script Fuji rồi chạy `node --env-file=.env apps/api/src/day3-worker.mjs --no-submit`. Luồng UI thủ công ở trên hoạt động độc lập với worker. Dữ liệu đưa cho OpenRouter phải phù hợp để gửi đến nhà cung cấp AI. Chỉ nhập dữ liệu giả lập khi thử.

## 5. Kiểm tra trước khi bàn giao

```powershell
npm.cmd run test:all
node services/prover/day2.mjs
npm.cmd --prefix contracts test
Push-Location contracts
npx.cmd hardhat run scripts/day3-replay-fuji-only.js
Pop-Location
npm.cmd run build:web
```

- Prover kiểm tra witness quá hạn, hoàn vượt trần, đổi case và public input bị sửa. CLI ghi proof mẫu tại `circuits/service_policy/target/proof-data.json`. Khi đổi circuit, cần xuất lại verifier bằng `--export-verifier`, chạy lại suite contract và triển khai verifier tương ứng.
- Replay chạy cả luồng Buyer nghiệm thu và luồng hoàn tiền có xác minh proof bằng Solidity trên Hardhat nhúng. Tx hash của replay thuộc phiên local đó.
- Kiểm thử AI thật với dữ liệu giả lập bằng `node --env-file=.env tests/day2-ai-live.mjs --pipeline`.
- Bản bàn giao đã qua 44 bài test backend và 16 bài test Solidity có proof thật. Kiểm tra tích hợp qua API, PostgreSQL và Hardhat xác nhận mua, tóm tắt OpenRouter, nghiệm thu và hoàn tiền. Giao dịch nộp proof trong lần chạy local dùng 545.170 gas.

## 6. Hạng mục còn mở

| Hạng mục | Tình trạng và cách xử lý |
| --- | --- |
| Deployment Fuji cho nhóm | RPC Fuji đã trả đúng chain ID. Workspace chưa có manifest Fuji-only và chưa có địa chỉ Seller/Reviewer của nhóm. Cần hoàn thành mục 3 rồi kiểm tra receipt mua, nộp proof và quyết toán trên Fuji. |
| Teleporter hai chiều | Tạm thời chưa dùng được trong bản bàn giao. Phần mở rộng cần xác nhận relayer, phí, peer và receipt trên cả hai chain trước khi bật lại. |
| Reviewer không phản hồi | Contract cho xử lý quá hạn với đơn `Paid`/`Delivered` qua `settleExpired`. Case đã `Disputed` cần Reviewer xử lý. Chưa có cơ chế thay Reviewer hoặc tự tất toán case tranh chấp. |
| OpenRouter Free | Có thể bị giới hạn quota, lỗi cấu trúc hoặc timeout. Thử lại đúng input sau khi có quota. Kết quả đã lưu gắn với order và input lần đầu. |
| Core hoặc RPC Local | Core có thể yêu cầu xác nhận chuyển mạng, thêm mạng thủ công hoặc đổi profile. RPC loopback chỉ dùng trên máy chạy Hardhat. Với nhiều máy, dùng Fuji và URL HTTPS của web. |
| Môi trường Internet công cộng | Bản testnet có giới hạn tốc độ trong một tiến trình. Cần bổ sung kiểm soát truy cập ở lớp hosting, audit contract và vận hành reviewer trước khi mở rộng. |
| Test proof cũ | Test `hello_world` có thể ở trạng thái pending nếu thiếu fixture cũ. Proof của marketplace nằm trong suite `service_policy`. |
