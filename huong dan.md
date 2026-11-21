# Hướng dẫn deploy Fuji và demo từ xa

Tài liệu này hướng dẫn một người chạy hệ thống trên máy Windows để ba thành viên có thể mở cùng một trang web và giao dịch trên **Avalanche Fuji C-Chain**, chain ID **43113**.

| Thành phần | Chạy ở đâu |
| --- | --- |
| Contract marketplace, escrow và ZK verifier | Trên Fuji. Mua, nộp proof, quyết toán và rút tiền đều gửi giao dịch lên Fuji. |
| Web, API và PostgreSQL | Trên máy người tổ chức demo. Docker Desktop chạy PostgreSQL. |
| Link demo | Cloudflare Quick Tunnel chuyển tiếp HTTPS tới web trên máy người tổ chức, cổng `3000`. |
| Ví Buyer, Seller và Reviewer | Mỗi người dùng Core trên máy mình để ký giao dịch. |

## 1. Chuẩn bị ví và project

Trong Core, cả nhóm bật **Testnet Mode** và chọn **Avalanche Fuji C-Chain (43113)**. RPC công khai là `https://api.avax-test.network/ext/bc/C/rpc`. Dùng ví test riêng cho Fuji. Khóa mặc định của Hardhat là khóa công khai dành cho local. Luồng demo trong tài liệu này thực hiện cả marketplace và tranh chấp trên Fuji C-Chain. Kết nối Custom Dispute L1 qua Teleporter tạm thời chưa khả dụng. [Thiết lập Core và Fuji](https://build.avax.network/academy/blockchain/x402-payment-infrastructure/05-hands-on-implementation/01-environment-setup)

| Vai trò | Cần chuẩn bị |
| --- | --- |
| Deployer | Ví test có AVAX testnet để trả gas deploy. Đặt khóa ví này trong `PRIVATE_KEY` ở `project/.env`. |
| Seller | Gửi địa chỉ C-Chain công khai để được cấp quyền Seller. Có AVAX testnet cho đăng ký listing, bàn giao và rút tiền. |
| Reviewer | Gửi địa chỉ C-Chain công khai để được cấp quyền Reviewer. Có AVAX testnet cho nộp proof, duyệt và gửi phán quyết. |
| Buyer | Gửi địa chỉ công khai cho Seller để nhận quote. Dùng ví khác Seller và có đủ `0.01 AVAX` testnet cho đơn mẫu cộng phí gas. |

Địa chỉ công khai là chuỗi `0x` + 40 ký tự hex, được dẫn xuất từ public key. Trong Core, copy địa chỉ **Receive → C-Chain**. Mỗi thành viên giữ riêng private key và seed phrase của mình. [Địa chỉ ví Core](https://build.avax.network/academy/avalanche-l1/avalanche-fundamentals/03-multi-chain-architecture-intro/06-setup-core) · [Faucet AVAX testnet](https://support.core.app/en/articles/6639882-core-web-how-do-i-use-the-testnet-faucet)

Nếu vừa clone repo hoặc chưa cài thư viện, cần **Node.js 22 trở lên**. Từ thư mục gốc của repo, chạy:

```powershell
Set-Location project
npm.cmd ci
npm.cmd --prefix contracts ci
npm.cmd --prefix services/prover ci
node apps/api/src/setup-env.mjs
```

Script tạo cấu hình local còn thiếu trong `project/.env`. Thêm hoặc cập nhật các biến sau, thay placeholder bằng cấu hình của bạn:

```dotenv
DAY3_SELLER=0x...
DAY3_REVIEWER=0x...
PRIVATE_KEY=KHOA_VI_DEPLOY_FUJI
OPENROUTER_API_KEY=KEY_OPENROUTER
OPENROUTER_MODEL=openrouter/free
DAY2_AI_MODE=openrouter
```

Giữ `DATABASE_URL`, `POSTGRES_PASSWORD` và `AES_KEY_HEX` đang dùng nếu tiếp tục với cơ sở dữ liệu cũ. Giữ `.env` trên máy host. Kiểm tra kỹ địa chỉ Reviewer vì script gán quyền cho ví đó trong contract lúc deploy.

## 2. Deploy contract lên Fuji

Từ thư mục `project`, chạy trong PowerShell:

```powershell
Push-Location contracts
try {
    npx.cmd hardhat run scripts/deploy-day3-fuji-only.js --network fuji
    if ($LASTEXITCODE -ne 0) { throw 'Deploy Fuji chưa hoàn tất.' }
} finally {
    Pop-Location
}
```

Lệnh gửi giao dịch lên **Fuji testnet** và dùng AVAX testnet của ví deploy trả gas. Docker và PostgreSQL dùng từ bước chạy app. Sau khi lệnh thành công, kiểm tra trong cùng terminal:

```powershell
Test-Path -LiteralPath '.\deployments\fuji-only\runtime.json'
```

Sau khi lệnh deploy thành công, `True` xác nhận manifest đã có để cấu hình app. Thư mục `project/deployments/fuji-only/` chứa địa chỉ contract, ABI và tx hash deploy. Giữ thư mục này để khởi động lại app hoặc chạy tiếp lần deploy đang dở với cùng ví deploy và Reviewer.

Phí deploy thực tế là tổng `gasUsed × effectiveGasPrice` của các giao dịch triển khai và cấu hình, dùng AVAX testnet. Tra phí từng giao dịch trong receipt hoặc trên explorer Fuji. Các giao dịch khi demo sẽ trả gas riêng. [Cách Avalanche tính phí giao dịch](https://build.avax.network/docs/rpcs/other/guides/txn-fees)

## 3. Bật Docker và chạy ứng dụng

Mở **Docker Desktop** và đợi Docker Engine sẵn sàng. Từ thư mục `project`:

```powershell
docker compose up -d postgres
docker compose exec -T postgres pg_isready -h 127.0.0.1 -U warranty -d warranty
```

Khi PostgreSQL báo `accepting connections`, chạy migration. Nếu container còn khởi động, đợi vài giây rồi chạy lại lệnh `pg_isready`.

```powershell
npm.cmd run migrate -w @warranty/api
```

Chờ migration in `Migrations complete`. Tùy chọn `-d` giữ container chạy nền. Nếu Docker CLI báo thiếu pipe Docker Engine, kiểm tra lại trạng thái Docker Desktop. [Docker Compose](https://docs.docker.com/reference/cli/docker/compose/up)

Nếu đang có bản local dùng cổng `3001` và `3000`, dừng API và web đó để dùng lại cổng. Sau đó mở **hai terminal riêng trong thư mục `project`**.

**Terminal API**

```powershell
. .\scripts\use-day3-fuji.ps1
$env:PORT = '3001'
npm.cmd run dev:api
```

**Terminal web**

```powershell
. .\scripts\use-day3-fuji.ps1
npm.cmd run build:web
npm.cmd exec -w @warranty/web -- next start
```

Script cấu hình nạp manifest Fuji cho cả API và web. Web đưa các địa chỉ contract vào bundle lúc build, nên hãy nạp cấu hình trước khi chạy `build:web`. Nếu dùng RPC tùy chỉnh qua `FUJI_RPC_URL`, đặt biến `$env:FUJI_RPC_URL` trong terminal deploy và trong hai terminal của app trước khi nạp cấu hình.

Mở `http://127.0.0.1:3001/health` và kiểm tra có `{"database":"ready"}`. Mở `http://127.0.0.1:3001/api/agents` và kiểm tra `scope` bắt đầu bằng `43113:`. `agents` có thể còn trống trước khi Seller đăng ký listing. Sau đó mở `http://localhost:3000/day3` và kiểm tra nút mạng hiện **Fuji (43113)**.

## 4. Chia sẻ link HTTPS cho team

Quick Tunnel tạo **link HTTPS tạm** và chuyển tiếp yêu cầu đến web cổng `3000` trên máy bạn. Máy bạn lưu code và dữ liệu, chạy API và PostgreSQL, đồng thời dùng đường truyền Internet của mình để phục vụ người truy cập. Quick Tunnel phù hợp cho demo ngắn, không cần mua tên miền hay gói hosting. [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

1. Tải bản Windows và mở PowerShell trong thư mục chứa chương trình. Nếu tải bản executable có tên khác, đổi tên thành `cloudflared.exe`. [Tải cloudflared](https://developers.cloudflare.com/tunnel/downloads/)
2. Chạy lệnh:

   ```powershell
   .\cloudflared.exe tunnel --url http://127.0.0.1:3000
   ```

3. Gửi URL HTTPS mà terminal in ra, thêm `/day3` ở cuối. Hai thành viên mở cùng link rồi kết nối Core và kiểm tra mạng **Fuji (43113)**.
4. Giữ máy host thức, Docker, API, web và terminal tunnel chạy trong suốt buổi demo. Mở Quick Tunnel mới sẽ có link mới.

Ai có link Quick Tunnel mặc định đều có thể mở trang. Dùng dữ liệu giả lập và chia sẻ link trong nhóm. Cloudflare cũng hỗ trợ giới hạn người mở link bằng email thông qua `--allowed-mail`. [Giới hạn truy cập Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/#restrict-access-by-email)

Để web mở được khi máy bạn tắt, cần một máy chủ chạy liên tục cho web, API và PostgreSQL. Contract và lịch sử giao dịch trên Fuji vẫn tra cứu được khi máy host dừng.

## 5. Demo và tra kết quả

Hai kịch bản bắt đầu bằng các bước chung:

1. **Seller** đăng ký **Document Summary** nếu listing còn trống, nhập địa chỉ Buyer và ký quote. Gửi **quote JSON** cho Buyer.
2. **Buyer** dán quote JSON và mua trên Fuji. Trong `/day3`, chọn đơn ở **Dịch vụ đã mua → Tóm tắt & hỏi đáp**. Chọn **Tải tệp để tóm tắt** để đọc `.docx` hoặc `.txt` (UTF-8), tối đa 10 MB và 12.000 ký tự. Kiểm tra văn bản đã trích hoặc nhập trực tiếp, rồi chọn **Ký và tóm tắt**. OpenRouter nhận phần văn bản khi bạn ký gửi. Bạn có thể mở bản tóm tắt đã lưu và hỏi tiếp về đúng tài liệu của đơn. Gửi **Order ID** và **Result hash** cho Seller. Nếu lần tóm tắt gặp lỗi, chọn **Ký và thử lại tài liệu đã lưu**.
3. **Seller** nhập Order ID và Result hash, sau đó ký **Mark Delivered**.

Chọn **Về đơn hàng** trong workspace AI để mở lại đúng đơn trên `/day3` và xem trạng thái mới nhất. Với đơn cũ chưa có trong danh sách, tra cứu bằng **Order ID** trên `/day3` bằng ví Buyer. Lịch sử chat chỉ hiện trong phiên đang mở.

Mỗi lần ký gửi tóm tắt dùng tối đa một request OpenRouter. Khi cần giữ quota cho buổi demo, có thể mở lại bản tóm tắt đã lưu hoặc dùng `npm.cmd run test:all` để kiểm thử backend bằng phản hồi AI mô phỏng.

**Plan A:** Buyer kiểm tra kết quả và bấm **Chấp nhận**. Seller vào **Số dư escrow**, làm mới số dư và chọn **Rút tiền (Withdraw)**.

**Plan B:** Dùng một đơn mới. Buyer mở tranh chấp trong thời hạn, ký gửi bằng chứng và chuyển **Case ID** cho Reviewer. Reviewer tra case và bấm **Bắt đầu phân tích** để chuyển case sang `Analyzing`. Tiếp đó nhập `5000000000000000` wei (**0,005 AVAX** trên đơn mẫu `0.01 AVAX**) vào ô **Số tiền hoàn (wei)** khi chạy thủ công, rồi chọn **Tạo proof bằng WASM → Nộp Proof**. Nếu worker đã lưu mức hoàn, để trống để dùng mức đó. Nút **Bắt đầu phân tích** chuyển trạng thái on-chain. Mục **Phân tích bằng AI** chạy riêng và có thể bỏ qua trong buổi demo. Khi case hiện `ProofVerified`, chọn **Chuyển vào Merchant Review → Duyệt hoàn tiền → Gửi phán quyết tới escrow**. Buyer về **Số dư escrow**, làm mới và chọn **Rút tiền (Withdraw)**.

Bấm link explorer trong **Nhật ký giao dịch**, hoặc copy tx hash của các bước **Mua**, **Nộp Proof**, **Gửi phán quyết** và **Withdraw**. Receipt nộp proof thành công có sự kiện `CaseProofVerified`, xác nhận contract đã kiểm tra ZK proof. Nội dung tài liệu, bằng chứng và kết quả AI thuộc phần xử lý và lưu trữ mã hóa của backend. [Fuji C-Chain Explorer](https://build.avax.network/explorer/fuji/c-chain)

## 6. Cập nhật sau buổi demo

- **Sửa web, API hoặc AI:** cập nhật và khởi động lại phần tương ứng, dùng lại manifest Fuji hiện tại. Cập nhật web thì build lại sau khi nạp cấu hình Fuji.
- **Sửa logic Solidity:** lưu thư mục manifest cũ ở đường dẫn khác để `deployments/fuji-only/` trống trước khi triển khai bộ contract mới. Script dùng lại địa chỉ từ `deployments/fuji-only/fuji.json` nếu file đó còn ở chỗ cũ. Sau khi deploy bộ mới, nạp lại manifest vào API, build lại web và tạo quote mới. Đơn hàng và tranh chấp cũ vẫn tra được theo địa chỉ contract cũ.

Xem [README của dự án](README.md) để biết thêm cách chạy local và kiểm thử.
