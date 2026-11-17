# Cập nhật kiểm chứng ngày 2026-11-17

Chốt mốc công việc ngày 1 theo yêu cầu của nhóm, kèm các mục tồn đọng được chuyển tiếp: Teleporter chiều về và kiểm thử AI live. Chưa đạt toàn bộ tiêu chí nghiệm thu kỹ thuật. File này thay thế trạng thái cũ về proof và ping V2 trong DAY1-REPORT.md.

## Proof: hoàn thành hello-world trên Dispute L1

- Native bb 0.82.2 lỗi Illegal instruction. Đã thay pipeline bằng @aztec/bb.js 0.82.2 WebAssembly, UltraPlonk, không dùng proof giả.
- Noir beta.3: 2 tests pass; witness được tạo bằng nargo.
- Proof thật 2144 bytes: local verify thành công, đổi public input bị từ chối.
- UltraVerifier.sol: deployed bytecode 11037 bytes, dưới giới hạn 24576.
- Verifier L1: `0x4e5FE516e05804bc27AE0a67d7Ce8750bd8aD955`.
- Deploy: `0x47f6c3d5b4e5961ef1b469103be823e155002acc45dc8bbf7045942ee9174f5b`.
- Verify thật block 12, gas 430653: `0xc9683a998cfe4cab2aeb9aaef60c4cd6e0a17e508c6bebe6fad23a735b6a1b87`.
- L1 từ chối proof bị sửa và public input sai. Các precompile cần cho verifier này hoạt động trong phép thử.
- Thư viện WASM MIT; Solidity sinh ra Apache-2.0, giữ header và license đi kèm.

Từ `project/services/prover`: `npm ci --workspaces=false`, rồi `npm run day1` (Windows cần Docker và nargo beta.3 trong project/.tools/noir).
Từ `project/contracts`: `node scripts/verifier-size.js`, `npx hardhat run scripts/deploy-verifier.js --network disputeL1`, `npx hardhat run scripts/verify-proof.js --network disputeL1`.
Deployment script tái dùng verifier có bytecode trùng. Đây là circuit x+y=z, chưa phải circuit policy marketplace ngày 2.

## Teleporter: chiều đi thật đã nhận; chiều về chờ chữ ký validator

- Ping Fuji: `0x74bf09996e74516b40f070d0a5f6637f0a330fb7c54af973244f4085368f9747`.
- L1 nhận qua TeleporterMessenger với Warp predicate thật, đồng thời tự phát pong: `0x8f3e621b98c0acd319a353698c88c44e06cac1d7ea47e4160749198d3dd96722`.
- Ping message ID: `0xf27862f2022576ee625b3e70855e80bfa2ced7dc780d38c16f5a1e3cfe9ceb8f`.
- Pong message ID: `0xf93b51e32f0dad341ef93fbbdd2b5e385e3484e10c69fdd1c98dc17e081a0b94`.
- Chưa có giao dịch nhận pong ở Fuji. Không tính việc L1 phát pong là hoàn tất hai chiều.
- Discovery công khai https://l1-validator-discovery-fuji.fly.dev/ ghi NodeID-Fvet9DW7LD65DL8ek1de49xBXUiJJgEt4 tại `10.146.2.83:9651`, lastSeenOnline=0. Địa chỉ này thuộc mạng riêng. Relayer đã thử kết nối: L1 connectedWeight=0/100.
- API chữ ký công khai trả được chữ ký Primary Network cho ping; yêu cầu chữ ký pong L1 trả HTTP 500 cả khi chỉ định và tự xác định subnet. Không có API key hay thanh toán.
- Để self-host relay chiều về: operator node cần cung cấp P2P endpoint công khai và quảng bá đúng IP/port, hoặc cung cấp đường mạng được phép tới validator. Không thể sửa cấu hình mạng của máy chủ quản lý từ contract ứng dụng.

Từ `project/contracts`: `npm run icm:roundtrip:api` tiếp tục vòng đã lưu, không gửi ping mới khi vòng còn pending. Lệnh dùng dịch vụ chữ ký công khai rồi tự gửi giao dịch tới Messenger; chain đích kiểm tra chữ ký BLS. Nó vẫn phụ thuộc khả năng dịch vụ lấy được chữ ký validator.
`npm run icm:check` audit chỉ đọc. `npm run icm:roundtrip` dùng official relayer P2P; cần kết nối validator trước khi ready.

## RPC và trạng thái khác

Official relayer đọc 200 block/lô nhưng public RPC Avalanche giới hạn 100. Đã thêm proxy chia lô, throttle và backoff 429; proxy chỉ bind localhost. PublicNode Fuji đã trả đúng chain ID 43113 và xử lý truy vấn 200 block thành công. Launcher dùng PublicNode miễn phí cho đọc RPC nguồn qua proxy; có thể cấu hình FUJI_RELAYER_RPC_URL. WS nguồn giữ cấu hình hiện tại. Endpoint khác không tự sửa đường P2P L1.

OPENROUTER_API_KEY vẫn thiếu ở lần kiểm tra cuối; chưa kiểm thử AI live. Backend/DB/AES và DApp build giữ kết quả đã báo cáo trước. Mốc ngày 1 được chốt để chuyển tiếp công việc; Teleporter hai chiều và AI live vẫn là các mục tồn đọng. Sáu test Hardhat pass; quét secrets không phát hiện khóa hiện tại trong file được đưa lên Git hoặc lịch sử Git.

Kiểm tra bản sửa RPC: official relayer đã ghi Finished processing historical logs với PublicNode, qua được bước đọc lịch sử. Phiên kiểm thử đã dừng; không có daemon mới được để chạy nền.
