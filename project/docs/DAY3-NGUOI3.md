# Day 3 · Người 3 — Tích hợp ví, Marketplace và Dispute UI

Trang làm việc: [`project/apps/web/app/day3/page.tsx`](../apps/web/app/day3/page.tsx) → mở `http://localhost:3000/day3`.

Mục tiêu sáng Ngày 3 (theo `AVALANCHE_DISPUTE_TO_MARKETPLACE_PLAN_DAY2_DAY5.md`):

- Kết nối ví Buyer / Seller / Reviewer, hiển thị đúng Fuji C-Chain và Dispute L1.
- Browse agent → Buy → Execute → View result → Accept / Dispute bằng API và contract thật.
- Reviewer page: approve/reject bằng ví đúng role, xem trạng thái proof và link explorer.

## Trạng thái đã hoàn thành

| Hạng mục | Trạng thái | Ghi chú |
|---|---|---|
| Build frontend | ✅ | `tsc --noEmit` và `npm run build:web` pass (đã sửa lỗi WIP: `publicClient`, `parseEther`, `customApiKey`) |
| Đọc listing thật từ `AgentRegistry.getAgent` | ✅ | Tab Buyer hiển thị seller, giá, dispute window, policy version, trạng thái active/approved |
| Quote EIP-712 do Seller ký | ✅ | Domain `ServiceOrderManager`/`1`, type `ServiceQuote` khớp `ServiceOrderManager.sol` |
| Policy commitment khớp prover | ✅ | `/api/day3/quote` tái sử dụng `services/prover/service-policy-input.mjs` (BLAKE2s); lưu witness vào `.runtime/day3/policies.json` và `policy-<orderId>.json` |
| Buyer mua bằng quote thật | ✅ | `purchaseService(agentId, salt, commitment, validUntil, v, r, s)` + đúng `msg.value` |
| Chạy AI qua backend + ký ví Buyer | ✅ | `POST /api/day3/orders/:id/execute`, scope dùng chain/order-manager của settlement chain |
| Buyer Accept / Open Dispute | ✅ | Có kiểm tra buyer, trạng thái order, cửa sổ khiếu nại; tự giải mã `CaseOpened` để điền Case ID |
| Seller `markDelivered` + `withdraw` | ✅ | Hoàn tất đường “Seller payout” (escrow ghi có, không tự chuyển tiền) |
| Reviewer role thật | ✅ | Đọc `reviewer()` từ `DisputeManager`; approve/reject bị chặn nếu ví sai role |
| Nộp ZK proof bằng ví reviewer | ✅ | Dán `{ proof, publicInputs }` do prover tạo; UI gọi `submitProof(caseId, amount, nullifier, proof)` |
| Trạng thái proof + explorer | ✅ | Hiển thị `proofRef`, payout đã xác minh, link case/contract/tx theo từng chain |
| 3 Dispute Agents | ✅ | Pipeline server-side; không nhận API key từ trình duyệt nữa |

## File đã đụng tới

- `apps/web/app/day3/page.tsx` — viết lại luồng Buyer / Seller / Reviewer.
- `apps/web/app/day3/day3.module.css` — thêm `.hint`.
- `apps/web/app/contracts.ts` — địa chỉ local lấy từ manifest runtime; thêm type `LocalAddresses`; escrow local.
- `apps/web/app/api/day3/config/route.ts` — **mới**: trả địa chỉ public từ `.runtime/day2/day2-local.json`.
- `apps/web/app/api/day3/quote/route.ts` — **mới**: tạo `policyCommitment` + lưu policy witness local.
- `apps/web/app/api/day3/pipeline/route.ts` — bỏ nhận `apiKey` từ request (chỉ dùng `OPENROUTER_API_KEY` ở server).

## Chạy local

```powershell
# Terminal 1
cd project/contracts
npx.cmd hardhat node

# Terminal 2 — deploy fixture + tạo order mẫu
cd project/contracts
npx.cmd hardhat run scripts/day2-prepare-api.js --network localhost

# Terminal 3 — PostgreSQL + API (nếu muốn chạy AI/DB)
cd project
docker compose up -d postgres
npm.cmd run migrate -w @warranty/api
$env:DAY2_AI_MODE = 'mock'
npm.cmd run dev:api

# Terminal 4
cd project
npm.cmd run dev:web
```

Mở `http://localhost:3000/day3`, thêm mạng **Hardhat Local** (`http://127.0.0.1:8545`, chain ID `31337`) vào ví.

Tài khoản Hardhat dùng cho demo:

- Seller: Account #1
- Buyer: Account #2
- Reviewer: Account #3 (đúng `reviewer` trong fixture)
- Admin: Account #0

Luồng thao tác:

1. **Seller**: kết nối Account #1 → tab Seller → nhập ví Buyer → **Ký EIP-712 Quote**.
2. **Buyer**: chuyển sang Account #2 → tab Buyer → kiểm tra quote xanh → **Mua dịch vụ**.
3. **Buyer**: **Ký ví & Gọi Service Agent**. Kết quả JSON và result hash hiện ra.
4. **Seller**: dán result hash → **Mark Delivered**.
5. **Buyer**: **Chấp nhận** → Seller **Withdraw**, hoặc **Mở tranh chấp**.
6. **Reviewer**: chuyển Account #3 + mạng Dispute L1 (cùng chain 31337 ở local) → tra cứu Case ID → **Bắt đầu phân tích**.
7. Tạo proof bằng prover của Người 2 rồi dán JSON vào ô “Nộp ZK Proof”. Khi Seller ký quote, API trả về và UI hiển thị
   đường dẫn witness, ví dụ `project/.runtime/day3/policy-<orderId>.json`:
   ```powershell
   cd project
   $fixture = Get-Content .runtime/day2/day2-api-fixture.json -Raw | ConvertFrom-Json
   $proof = node --env-file=.env apps/api/src/prove-case.mjs $fixture.caseId 5000000000000000 .runtime/day3/policy-<orderId>.json
   $proof | Set-Content -Encoding ascii .runtime/day3/day3-case-proof.json
   ```
   > `prove-case.mjs` cần đúng witness `{ disputeWindow, maxRefund, nonce }` của order đang tranh chấp; API đã ghi sẵn
   > một file cho mỗi order và giữ thêm map tổng hợp ở `.runtime/day3/policies.json`.

8. Reviewer **Chuyển vào Merchant Review → Approve → Gửi kết quả về Fuji**.
9. Với local, chạy `scripts/day2-settle-api.js` để mock messenger chuyển kết quả về C-Chain (chiều L1 → Fuji thật vẫn là việc của Người 1/2).

## Việc còn lại (không thuộc sáng Ngày 3 của Người 3)

- **Endpoint `POST /api/cases/:id/prepare-proof`** do Người 2 làm; hiện UI cho dán proof JSON thay vì tự gọi prover.
- **`policies.json` chỉ là demo local, chưa mã hóa**. Production phải lưu AES-256-GCM, chỉ prover/API đọc.
- **Địa chỉ Fuji/Dispute L1** phải được deploy và điền `NEXT_PUBLIC_FUJI_*` / `NEXT_PUBLIC_L1_*` (Người 1).
- **Chiều Teleporter L1 → Fuji** và relayer vẫn là blocker hạ tầng đã ghi trong `docs/DAY1-REPORT.md`.
- **Reviewer proof status**: UI hiển thị đúng dữ liệu on-chain, nhưng chưa tự polling; bấm “Tra cứu” để refresh sau khi relay xong.
- **Quote expiration**: quote hết hạn phải được Seller ký lại; không có endpoint refresh tự động.
- **UI chưa hiển thị `CaseResolutionCommitted` message ID**; có thể đọc từ receipt của `sendResolution` ở bước tiếp theo.
- Không thêm Service Agent thứ hai trong Ngày 3 (theo kế hoạch, chỉ P1 sau khi E2E xong).

## Ghi chú kiến trúc

- Mỗi thao tác ghi contract đều kiểm tra mạng trước; `ensureChain` chuyển mạng rồi yêu cầu bấm lại để tránh gửi tx bằng `walletClient` cũ.
- Địa chỉ Fuji/L1 lấy từ biến public; địa chỉ local đọc từ manifest để không dùng nhầm địa chỉ của lần deploy trước.
- `policyCommitment` được tạo trước khi Seller ký, ở server, từ witness thật; Buyer không tự sinh commitment ngẫu nhiên như bản WIP trước đó.
