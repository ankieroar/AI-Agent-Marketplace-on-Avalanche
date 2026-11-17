# Báo cáo triển khai ngày 1

Ngày thực hiện: 2026-11-17. Chưa đạt toàn bộ Go/No-Go ngày 1: relayer ICM thật, Barretenberg proof/verifier và LLM live còn thiếu điều kiện kiểm thử. Không dùng kết quả fallback thay thế bằng chứng Teleporter.

## Đã triển khai và kiểm chứng

- Monorepo npm workspaces cho API, web, schema và agents; package-lock được tạo.
- Backend Express/pg; PostgreSQL 16 local chạy bằng compose; migration thành công.
- AES-256-GCM: key 32 bytes, IV ngẫu nhiên 12 bytes, auth tag, AAD=record ID. Test roundtrip và chống sửa/sai key/sai ID pass.
- Test DB thật: insert ciphertext, đọc lại và giải mã đúng, không có plaintext; rollback sau test.
- HTTP smoke test: health kết nối DB, từ chối request không có token, từ chối body sai schema đều pass.
- Schema policy và CaseOpened dùng chung, commitment ABI/Keccak có domain version; test đổi field/nonce làm đổi commitment pass. Chưa tích hợp commitment này vào Noir circuit bảo hành thật (ngoài phạm vi hello-world ngày 1).
- Adapter OpenRouter free-only, ba prompt và pipeline chạy tuần tự. Test dùng mock cho JSON schema, payout cap, model trả phí, HTTP 429 và JSON lỗi: 4 test Node tổng cộng pass. Chưa gọi LLM thật vì chưa có key.
- Next.js/Tailwind/wagmi/viem: kết nối injected wallet và chuyển Fuji/Dispute L1; không chứa key API ở client. Production build đã PASS (compile, TypeScript strict, prerender và build traces) bằng Node 22; Node 20.18 gây lỗi ESM của dependency mới. Đã đồng bộ React/React DOM và viem/wagmi. Chưa kiểm thử tương tác ví bằng trình duyệt.
- Noir v1.0.0-beta.3 cài vào `.tools`; hello-world x+y=z đã pass 2 test (valid và should_fail), execute sinh witness thành công.
- Strict TeleporterPingPong: chỉ Messenger có quyền nhận, kiểm tra chain/sender, chống replay, peer khóa sau cấu hình. Hardhat compile và 1 test bảo vệ receiver pass.
- Có `infra/avalanche-l1/config.json`; giữ L1 hiện tại, không dựng thêm L1 hoặc bịa NodeID. RPC xác nhận 662831, ví có DISP testnet; Fuji có AVAX testnet. Không cần faucet thêm.

## Giao dịch testnet mới

Chi tiết máy đọc được trong `icm-roundtrip.json`, audit RPC trong `day1-chain-audit.json`.

- Strict app Fuji: `0x47D04E893D61f9da81f4A3ce1BF35B43309f0024`
- Deploy Fuji: `0x8725f5f35b10350c2db845e42824bafdb24ef97efba3c3977a106ab72bf29fe0`
- Strict app Dispute L1: `0x917dc355da9AEE67d8f52453A97f6a3f0A69AfF5`
- Deploy L1: `0x6685f54114836422a23f115029928652456ed738ccf16902721782342b491d97`
- Ping nguồn Fuji: `0x0edfd26f979ce76b8a5fe183738c8f39345db115a8698e94935e302ab2c8be98`
- Message ID: `0xd6e867ddd81b7619d38a63d48b33560b83c105431893f557155b1fb91be40be6`
- Trạng thái tại kiểm tra: WAITING FOR REAL RELAYER; chưa có hash nhận, chưa gửi chiều ngược. Cả hai chain có Messenger code nhưng code hash khác nhau, chưa kết luận tương thích. Chưa deploy Registry mới.

## Điều kiện còn thiếu

1. Chủ Builder Hub kiểm tra/khôi phục relayer thực sự cho đúng cặp blockchain và Messenger. P-Chain đã trả về validator NodeID-Fvet9DW7LD65DL8ek1de49xBXUiJJgEt4, lưu trong config.json; mô hình permissioned vẫn cần đối chiếu quản trị thực tế. Hoặc cần cấu hình và vận hành relayer ICM chính thức cùng quyền truy cập validator/signature aggregation. Daemon JS fallback không làm việc này.
2. Native bb v0.82.2 tải được nhưng chạy `bb --version` lỗi Illegal instruction trong Docker VM hiện tại. Cần Linux/WSL phù hợp CPU hoặc phương án WASM/build baseline đã xác minh. Chưa sinh VK/proof/Solidity, chưa đo bytecode thật, chưa deploy verifier, chưa gọi verify trên L1. Witness thành công không phải proof thành công.
3. OPENROUTER_API_KEY chưa cấu hình; cần operator tự lưu key Free vào .env, không gửi vào chat. Chưa kiểm tra chất lượng output LLM thực tế; schema không bảo đảm sự thật của hóa đơn/AI.

## Chi phí, license và vận hành

Chỉ dùng token Fuji/DISP testnet và công cụ local, không nạp tiền hoặc gọi API tính phí. Adapter chặn model trả phí trước request, không fallback trả phí. OpenRouter free quota có giới hạn, hết thì fail.

Docker Desktop có điều kiện subscription theo tổ chức. PostgreSQL dùng PostgreSQL License; Express/Next/Tailwind/viem/wagmi dùng các license mã nguồn mở của dependency tương ứng. Noir/BB và ICM cần giữ/đọc license theo release. ICM upstream hiện dùng LicenseRef-Ecosystem; chưa sao chép toàn bộ source Messenger/Registry vào repo. Không tuyên bố mọi dependency là không có điều kiện license.

Backend chỉ dành phát triển local: token dùng chung, chưa có ACL từng hồ sơ, rate limit và quản lý khóa theo vòng đời. Mất AES key sẽ không giải mã được dữ liệu cũ. Không dùng dữ liệu người thật trong demo. Script roundtrip lưu tiến độ nhưng chưa chịu được mọi tình huống mất kết nối giữa broadcast và ghi file; nếu gặp lỗi phải kiểm tra source tx trước khi gửi lại.

Hướng dẫn: `../README-DAY1.md`. Schema: `message-schema.md`. Thay đổi kế hoạch mới và khác biệt với prototype: `PLAN-UPDATE.md`. Commit này là nền tảng ngày 1, chưa phải nghiệm thu hoàn thành mọi mục ngày 1.
