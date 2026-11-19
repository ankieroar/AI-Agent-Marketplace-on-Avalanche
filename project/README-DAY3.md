# Ngày 3 — Marketplace và tranh chấp trên Fuji

Thư mục chạy trên máy này là `D:\26120200\team1_vietnam_unihack\project`. Nhánh backend Người 2 đã hợp nhất với hợp đồng Người 1 và UI Người 3. Prover dùng Noir beta.3 và Barretenberg WASM 0.82.2. Bật Docker Desktop trên Windows khi tạo proof.

## 1. Kiểm tra tại máy

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
