# Ngày 3 — Marketplace và tranh chấp trên Fuji

Thư mục chạy trên máy này là `D:\26120200\team1_vietnam_unihack\project`. Nhánh backend Người 2 đã hợp nhất với hợp đồng Người 1 và UI Người 3. Prover dùng Noir beta.3 và Barretenberg WASM 0.82.2. Bật Docker Desktop trên Windows khi tạo proof.

## 1. Demo bằng giao diện trên Hardhat local

Bật Docker Desktop. Mở bốn terminal PowerShell. Mỗi lần khởi động lại Hardhat, triển khai lại contract ở Terminal 2 rồi tải lại trang. Giữ node mở trong lúc chạy cả hai kịch bản.

**Terminal 1 — blockchain local và địa chỉ ví test**

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project\contracts'
npx.cmd hardhat node
```

Trong Core, import tài khoản test #1, #2 và #3 bằng khóa Hardhat in ở terminal. Ba vai lần lượt là Seller, Buyer và Reviewer. Khi ký quote, lấy **địa chỉ công khai #2** để điền vào ô Buyer.

**Terminal 2 — triển khai hợp đồng và đăng listing mẫu**

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project\contracts'
$env:DAY2_RPC_URL = 'http://127.0.0.1:8545'
npx.cmd hardhat run scripts/day3-prepare-local.js --network localhost
```

Script in địa chỉ ba vai và ghi `.runtime/day2/day2-local.json` cho web và API. Mỗi đơn trong hai kịch bản sẽ được mua trên web.

**Terminal 3 — PostgreSQL, API tạo quote, agent và proof**

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
docker compose up -d postgres
npm.cmd run migrate -w @warranty/api
$env:DAY2_CHAIN_MODE = 'local'
$env:DAY2_RPC_URL = 'http://127.0.0.1:8545'
$env:DAY2_CONTRACTS_FILE = (Resolve-Path '.runtime/day2/day2-local.json').Path
$env:DAY3_L1_MANIFEST = $env:DAY2_CONTRACTS_FILE
$env:DAY2_AI_MODE = 'mock'
npm.cmd run dev:api
```

Mặc định ở hướng dẫn này, Service Agent dùng kết quả mẫu để bạn test bàn giao và quyết toán mà không phụ thuộc OpenRouter. Để test AI thật, đặt `DAY2_AI_MODE` thành `openrouter` trước khi chạy API, dùng key OpenRouter trong `.env` và nhập tài liệu demo khác. Đợi API báo cổng 3001 trước khi ký quote. Nếu migration báo lỗi, xử lý lỗi đó trước khi chạy API.

**Terminal 4 — giao diện**

```powershell
cd 'D:\26120200\team1_vietnam_unihack\project'
npm.cmd run dev:web
```

Mở `http://localhost:3000/day3`, kết nối ví test và chọn **Local (31337)**. Nếu Core từ chối chuyển mạng từ web, chọn Hardhat Local trực tiếp trong Core. Thông số mạng là RPC `http://127.0.0.1:8545`, Chain ID `31337`, ký hiệu `ETH`. Kiểm tra tên mạng và địa chỉ ví đang dùng trước khi ký từng thao tác.

### Plan A — Buyer chấp nhận, Seller rút tiền

1. **Seller #1** nhập địa chỉ công khai **Buyer #2** và bấm **Ký EIP-712 Quote**.
2. **Buyer #2** bấm **Mua dịch vụ**, xác nhận giao dịch, nhập tài liệu mẫu và bấm **Ký ví & Gọi Service Agent**. Lấy **Order ID** và **Result hash**.
3. **Seller #1** kiểm tra hai ô Order ID và Result hash đúng với đơn vừa mua, rồi bấm **Mark Delivered**.
4. **Buyer #2** tra cứu cùng đơn, bấm **Chấp nhận**. **Seller #1** làm mới số dư escrow và bấm **Withdraw**.

### Plan B — Buyer mở tranh chấp và nhận hoàn tiền

1. Lặp lại ba bước đầu Plan A với một quote và đơn mới. Buyer nhập văn bản demo khác để dễ phân biệt hai kết quả.
2. **Buyer #2** bấm **Mở tranh chấp**. UI lấy `caseId` từ giao dịch. Thêm bằng chứng giả lập rồi bấm **Ký và gửi bằng chứng**.
3. **Reviewer #3** tra cứu case vừa tạo và bấm **Bắt đầu phân tích**. Điền `5000000000000000` wei vào ô hoàn tiền rồi bấm **Tạo proof bằng WASM**. Giữ Docker Desktop chạy cho Noir.
4. **Reviewer #3** bấm **Nộp Proof → Chuyển vào Merchant Review → Duyệt hoàn tiền → Gửi phán quyết tới escrow**. Case và escrow nằm trên cùng node Hardhat, kết quả áp dụng trong giao dịch gửi phán quyết.
5. **Buyer #2** vào phần rút tiền trong tab Seller, bấm **Làm mới số dư → Withdraw**. Số hoàn dự kiến là **0,005 AVAX local**.

## Kiểm tra tự động trên Hardhat

```powershell
cd D:\26120200\team1_vietnam_unihack\project
docker compose up -d postgres
npm.cmd run migrate -w @warranty/api
npm.cmd run test:all
node services/prover/day2.mjs
cd contracts
npx.cmd hardhat test
npx.cmd hardhat run scripts/day3-replay-fuji-only.js
```

Replay chạy trên Hardhat 31337. Nó tạo hai order, dùng result hash mẫu và ký bằng tài khoản Hardhat. Order đầu trả Seller khi Buyer accept. Order thứ hai mở tranh chấp, tạo proof thật, xác minh, duyệt refund và rút tiền. Các tx hash của replay chỉ tồn tại trong phiên Hardhat đó.

Test model thật với tài liệu giả lập từ thư mục `project` bằng `node --env-file=.env tests/day2-ai-live.mjs --pipeline`. Cần `OPENROUTER_API_KEY` server-side và model miễn phí.

## 2. Deploy chế độ một chain

Đặt `PRIVATE_KEY` của ví deploy testnet trong `project/.env`, `DAY3_REVIEWER` là địa chỉ công khai cố định của reviewer, `DAY3_SELLER` là địa chỉ công khai được duyệt đăng listing. Nạp gas Fuji testnet cho các ví sẽ ký. Buyer dùng ví khác Seller.

```powershell
cd D:\26120200\team1_vietnam_unihack\project\contracts
npx.cmd hardhat run scripts/deploy-day3-fuji-only.js --network fuji
```

Script dùng cùng một Fuji blockchain ID cho hai đầu và triển khai verifier thật. Messenger chuyển claim và resolution ngay trong giao dịch gọi contract. Receiver kiểm tra messenger và peer. Manifest riêng ở `deployments/fuji-only/fuji.json`; API và worker dùng `runtime.json` chứa ABI. Quy trình hai chain cũ còn trong `docs/DAY3-NGUOI1.md`.

## 3. Khởi động ứng dụng

Trong **mỗi terminal** chạy hai dòng sau để dùng đúng manifest và RPC:

```powershell
cd D:\26120200\team1_vietnam_unihack\project
. .\scripts\use-day3-fuji.ps1
```

| Terminal | Lệnh tiếp theo |
|---|---|
| API | `npm.cmd run dev:api` |
| Worker | `node --env-file=.env apps/api/src/day3-worker.mjs --no-submit` |
| Web | `npm.cmd run dev:web` |

Chọn `DAY2_AI_MODE=openrouter`, `DAY3_AI_MODE=openrouter`, `OPENROUTER_MODEL=openrouter/free` và cấu hình PostgreSQL, AES, key OpenRouter ở server. Chế độ worker trên dành bước ký proof cho ví reviewer trong UI.

## 4. Demo chiều Ngày 3

Mở `http://localhost:3000/day3`; kết nối ví với Fuji 43113.

1. Seller đăng Document Summary nếu chưa có listing, nhập địa chỉ Buyer và ký quote. Nếu Buyer dùng trình duyệt khác, chuyển JSON quote cho Buyer. API lưu witness mã hóa trước khi trả commitment.
2. Buyer mua đúng giá, ký yêu cầu chạy agent và nhận kết quả. Seller ghi nhận giao hàng bằng result hash. Buyer accept và Seller withdraw. Lưu receipt mua, accept và withdraw.
3. Tạo quote và order thứ hai. Buyer mở tranh chấp, ký và gửi bằng chứng. Worker đối chiếu order với policy đã commit, xử lý bằng chứng và đề xuất hoàn tiền.
4. Reviewer tra cứu case trên Fuji, bắt đầu phân tích, tạo proof bằng WASM cho số tiền hợp lệ, ký nộp proof, chuyển Merchant Review, duyệt rồi gửi kết quả. Buyer withdraw phần refund. Ghi lại case ID, receipt proof, receipt settlement, sự kiện Delivered, số wei và thời gian block.

Chỉ chốt bàn giao testnet sau khi có receipt thành công và số dư escrow khớp cho cả hai order. Test transport trên Hardhat và báo cáo preflight là các phép kiểm tra riêng.
