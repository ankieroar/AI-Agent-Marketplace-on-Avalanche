# Day 3 · Người 2 — Backend worker: `ServicePurchased` → Dispute pipeline

Phạm vi: checklist sáng Ngày 3 của Người 2 trong
`AVALANCHE_DISPUTE_TO_MARKETPLACE_PLAN_DAY2_DAY5.md` (dòng 231–234).

Mục tiêu:

- Watch `ServicePurchased` trên settlement chain → chạy service executor cho order hợp lệ, không chạy lặp.
- Watch case mở trên Dispute L1 → Evidence/Policy/Resolution → prover → nộp proof bằng submitter quyền tối thiểu.
- Thống nhất trạng thái order/case, xác nhận giao dịch và retry; không báo thành công trước final state.
- Không dùng mock như bằng chứng on-chain.

## Trạng thái

| Hạng mục | Trạng thái | Ghi chú |
|---|---|---|
| Migration `004-day3-worker.sql` | ✅ | `chain_events`, `worker_checkpoints`, `service_requests`, `case_jobs` |
| Event ledger + checkpoint | ✅ | Mỗi log có `event_key` duy nhất; checkpoint chỉ tiến sau khi batch xử lý xong |
| Watch `ServicePurchased` | ✅ | Chỉ xử lý order đã confirmed; đối chiếu event ↔ order ↔ listing ↔ policy |
| Idempotency service executor | ✅ | `agent_outputs` + `input_hash` + lease; event replay bị skip |
| Watch case mở | ✅ | Gateway `CaseOpened` (C-Chain) và L1 `CaseStatusChanged(Opened)` / `CaseOpened` |
| Evidence → Policy → Resolution | ✅ | Pipeline service riêng; chỉ gửi public policy fields cho model |
| Prover + kiểm tra public inputs | ✅ | 15 public inputs khớp `ProofGate.publicInputs()` trước khi nộp |
| Submitter quyền tối thiểu | ✅ | Bắt buộc là `reviewer()`, không phải admin/deployer |
| Xác nhận giao dịch + retry | ✅ | Receipt thành công **và** đọc lại final state; timeout không gửi trùng mù |
| API trạng thái order/case | ✅ | `GET /api/orders/:id`, `GET /api/cases/:id` trả thêm job/request/case status |
| API tạo proof cho UI | ✅ | `POST /api/cases/:id/prepare-proof` đọc witness đã mã hóa, kiểm tra claim và trả `{ proof, publicInputs }` |
| Test offline | ✅ | `npm.cmd run test:day3` — 19/19; `test:proof` — 7/7; `test:all` — 44/44 pass |
| Chạy staging thật | ⛔ | Máy hiện tại không có `.env`, PostgreSQL, RPC/manifest hoặc prover toolchain |

Checklist Ngày 3 trong kế hoạch đã được tick cho phần **code/migration/test offline**. Các mục bàn giao yêu cầu chạy thật (kịch bản A/B, tx hash thật) vẫn chưa được tick cho tới khi có staging.

## Kiến trúc

```text
Fuji C-Chain                                   Dispute L1
ServiceOrderManager.ServicePurchased           DisputeManager.CaseStatusChanged(Opened)
MarketplaceGateway.CaseOpened                  (hoặc CaseOpened nếu ABI có)
        |                                               |
        v                                               v
  chain_events (unique event_key)  <---- event ledger ----+
        |                                               |
  service executor                                case_jobs (lease)
  agent_outputs                                   evidence + policy witness
  encrypted result                                Evidence -> Policy -> Resolution
        |                                               |
  GET /api/orders/:id                             Noir prover + public input check
                                                  startAnalysis -> submitProof (reviewer)
                                                  receipt + final state read-back
                                                          |
                                                  GET /api/cases/:id
```

Hai chain dùng hai manifest/RPC độc lập:

- Service chain: `DAY3_SERVICE_RPC_URL`, `DAY3_SERVICE_MANIFEST`.
- Dispute L1: `DAY3_L1_RPC_URL`, `DAY3_L1_MANIFEST`.
- Local có thể dùng cùng `day2-local.json` cho cả hai.

## File đã thêm/đụng tới

Mới:

- `apps/api/migrations/004-day3-worker.sql` — event ledger, checkpoint, service request, case job.
- `apps/api/src/day3-worker.mjs` — CLI, watcher, service/case orchestration, preflight.
- `apps/api/src/day3-events.mjs` — validate event/claim, commitment, payout, proof public inputs.
- `apps/api/src/day3-state.mjs` — PostgreSQL store cho worker.
- `apps/api/src/day3-tx.mjs` — gửi tx, chờ receipt, đọc lại final state, retry.
- `apps/api/src/service-executor.mjs` — executor dùng chung cho API execute và worker.
- `apps/api/src/prepare-proof.mjs` — tạo proof cho UI từ policy đã mã hóa; không trả witness.
- `tests/day3-worker.test.mjs` — 19 test offline với store/chain/prover giả.
- `tests/prepare-proof.test.mjs` — 7 test cho endpoint tạo proof, cap refund và public inputs.
- `docs/DAY3-NGUOI2.md` — tài liệu này.

Sửa:

- `apps/api/src/day2-chain.mjs` — thêm `listing()`, `day2CaseChain()`, manifest validation.
- `apps/api/src/day2-routes.mjs` — executor dùng chung; upload evidence đọc claim từ L1; trả request/case job.
- `apps/api/src/migrate.mjs` — xác nhận cả bảng Day 3 sau migration.
- `apps/api/src/day3-events.mjs` — `verifyCaseClaim()` chỉ trả các field của `Claim` struct để prover strict schema không bị lỗi khi chạy thật.
- `apps/api/src/day2-routes.mjs` — mount `POST /api/cases/:id/prepare-proof`.
- `apps/web/app/api/day3/[...path]/route.ts` — proxy cho phép UI gọi endpoint tạo proof.
- `services/agents/index.mjs` — `runServiceDisputePipeline()` + mock fixture an toàn.
- `services/prover/service-policy-input.mjs` — `serviceClaim` chấp nhận `nonce`/`lockedAmount` của struct on-chain.
- `package.json`, `apps/api/package.json`, `.env.example` — script và biến môi trường Day 3.

## Chạy

```powershell
cd project

# 1. Schema (DATABASE_URL trỏ staging app account, quyền tối thiểu)
npm.cmd run migrate -w @warranty/api

# 2. Kiểm tra DB + hai RPC + contract + submitter; không ghi gì lên chain
node --env-file=.env apps/api/src/day3-worker.mjs --check

# 3. Một batch rồi thoát (phù hợp smoke test)
node --env-file=.env apps/api/src/day3-worker.mjs --once

# 4. Chỉ service hoặc chỉ case
node --env-file=.env apps/api/src/day3-worker.mjs --once --service-only
node --env-file=.env apps/api/src/day3-worker.mjs --once --cases-only

# 5. Chạy nền
node --env-file=.env apps/api/src/day3-worker.mjs

# 6. Xử lý trực tiếp một order/case đã biết
node --env-file=.env apps/api/src/day3-worker.mjs --order-id 0x...
node --env-file=.env apps/api/src/day3-worker.mjs --case-id 0x...
```

`--no-submit`: chạy agents + prover nhưng dừng trước `startAnalysis`/`submitProof`.
Dùng để kiểm tra pipeline khi chưa cấu hình submitter.

Worker log JSON ra stdout, ví dụ:

```json
{"time":"...","event":"worker-tick","service":{"status":"ok","logs":2,...},"cases":{"status":"ok","logs":1,...}}
```

Không log witness, service input, evidence hay output model.

## Trạng thái và idempotency

### `ServicePurchased`

1. Query log trong khoảng `checkpoint + 1 → latest - confirmations + 1`.
2. Ghi `chain_events` với khóa `chainId:contract:txHash:logIndex`.
   - `processed`/`skipped`: bỏ qua vĩnh viễn.
   - `failed`: retry, tối đa `DAY3_MAX_ATTEMPTS`.
3. Đọc order đã confirmed + listing + policy đã seed.
4. Cross-check:
   - agent, buyer, seller, giá, commitment, version, `purchaseTimestamp`;
   - listing price == escrow price;
   - `disputeWindow` listing == witness;
   - `claimDeadline == purchaseTimestamp + disputeWindow`;
   - commitment tính lại từ witness == commitment on-chain.
5. Lấy input:
   - ưu tiên `service_requests` (buyer đã ký qua `POST /api/orders/:id/execute`, lưu AES-256-GCM);
   - sau đó `DAY3_SERVICE_INPUT_TEXT` / `DAY3_SERVICE_INPUT_FILE` cho demo.
6. Chạy executor. `agent_outputs` là boundary idempotency: một `input_hash`, một lease, một kết quả.
7. Không có input → event được đánh dấu processed; request đến sau được `processPendingServiceRequests()` xử lý.

Thiếu policy đã seed là lỗi **retryable** để seed muộn vẫn giao được order.
Checkout sai (commitment/giá/window/version) là lỗi **permanent** và bị skip.

### Case mở

Hai nguồn, cùng một `case_jobs` row:

1. **C-Chain `MarketplaceGateway.CaseOpened`**: xác nhận order đang `Disputed`, `caseId`/commitment/version khớp; nếu L1 chưa có claim thì tạo job `awaiting_relay`.
2. **L1 `DisputeManager`**: dùng `CaseOpened` nếu ABI có, ngược lại `CaseStatusChanged(caseId, Opened)` sau `DisputeInbox.ingest`.

Khi claim đã có trên L1:

1. Đọc `DisputeManager.getCase(caseId)`; status phải là `Opened`/`Analyzing`.
2. Giải mã policy witness theo AAD `service-policy:<orderId>`.
3. Tính lại commitment; kiểm tra claim window, `maxRefund <= lockedAmount`, nonce == caseId, order/case khớp.
4. Giữ lease `case_jobs` (một worker xử lý một case tại một thời điểm).
5. Evidence: ưu tiên bản buyer upload trong PostgreSQL, sau đó file/env demo.
6. Chạy Evidence/Policy/Resolution. Chỉ public fields (`purchaseTimestamp`, `claimDeadline`, `maxRefund`) được gửi model; nonce không rời prover.
7. Payout = 0 → `rejected`, không prove, không submit.
8. Payout > 0 → cap theo `maxRefund` và `lockedAmount`; lưu analysis mã hóa; prove.
9. Kiểm tra 15 public inputs khớp claim + payout + nullifier khác 0.
10. `startAnalysis` nếu status `Opened`; `submitProof` nếu status `Analyzing`.
11. Chỉ thành công khi receipt `status == 1` **và** đọc lại thấy case `ProofVerified` với đúng `proofRef = keccak256(proof)`.

`beginReview`/`decide` vẫn do reviewer trên UI thực hiện; worker dừng ở `ProofVerified`.

## Xác nhận giao dịch và retry

- Không bao giờ báo thành công chỉ từ tx hash.
- `proof_tx_hash` / `start_tx_hash` là hash giao dịch thật từ receipt, không phải hash proof.
- Nếu tx đã gửi nhưng timeout: lưu trạng thái `failed` kèm lỗi; lần sau kiểm tra `applied()` trước khi gửi lại, tránh gửi trùng.
- Retry mạng: `ECONNRESET`, timeout, nonce too low, replacement transaction… với backoff.
- `CALL_EXCEPTION`, revert, thiếu tiền, nonce expired: không retry mù.
- Case job `analyzing`/`proved` có lease; hết lease mới được resume.
- `submitted`/`rejected` là terminal, không xử lý lại.
- Event quá `DAY3_MAX_ATTEMPTS` bị đánh dấu skipped/dead. Muốn chạy lại có chủ đích:

```sql
UPDATE chain_events
SET status = 'failed', attempts = 0, last_error = NULL
WHERE event_key = '<event_key>';
```

Đây là thao tác vận hành có kiểm soát, không phải retry tự động.

## Submitter quyền tối thiểu

`DAY3_SUBMITTER_PRIVATE_KEY` phải:

- đúng `DisputeManager.reviewer()`;
- **không** trùng `DisputeManager.admin()`;
- **không** trùng deployer (`PRIVATE_KEY`);
- có balance để trả gas.

`--check` in ra địa chỉ reviewer/admin và balance, dừng nếu vi phạm.

Hợp đồng hiện tại chỉ cho `reviewer` gọi `startAnalysis`/`submitProof`. Vì vậy
"relayer/submitter riêng" phải là một key được cấp đúng role reviewer, không phải
admin. Nếu nhóm muốn tách relayer khỏi reviewer, cần Người 1 đổi contract; Người 2
không tự đổi role/message contract.

## AI mode và quy tắc không giả on-chain

- `DAY3_AI_MODE=openrouter` (mặc định): gọi model thật, cần `OPENROUTER_API_KEY` trên server.
- `DAY3_AI_MODE=mock`: fixture deterministic, **không phải quyết định thật**.
  - Mặc định `eligible=false`, payout `0` → không tạo proof, không submit.
  - Chỉ khi đặt `DAY3_MOCK_ELIGIBLE=1` mới tạo payout `1` wei để test đường proof/submit trên local.
  - `mode: "mock"` được lưu trong analysis mã hóa; không dùng làm bằng chứng demo/pitch.
- Service executor mock ghi caveat `Local fixture output.` trong kết quả.
- Mọi tx hash/proof trong DB đến từ receipt/chain thật; không có tx giả.
- `--check` không gửi giao dịch.

## API trạng thái

- `GET /api/orders/:id` — order on-chain + `execution` + `request` + `case` job.
- `GET /api/cases/:id` — claim from Dispute L1 + `worker` job.
- `POST /api/orders/:id/execute` — buyer ký; lưu input mã hóa và chạy executor.
- `POST /api/cases/upload` — buyer ký; lưu evidence mã hóa theo `caseId`.
- `POST /api/cases/:id/prepare-proof` — tạo proof cho reviewer dán vào `submitProof`:
  ```powershell
  curl -X POST http://127.0.0.1:3001/api/cases/0x.../prepare-proof `
    -H "Content-Type: application/json" -d '{"refundWei":"5000000000000000"}'
  ```
  Body có thể bỏ trống nếu worker đã lưu `payout_amount` trong `case_jobs`; nếu có cả hai,
  `refundWei` phải khớp analysis. Số tiền luôn bị cap bởi `min(maxRefund, lockedAmount)`;
  response gồm `{ caseId, orderId, payoutWei, nullifier, proof, publicInputs, proofHash }`.
  Endpoint **không gửi transaction**, không trả witness/nonce riêng tư và có rate limit theo IP.

API không trả witness, nonce, evidence plaintext hoặc analysis plaintext.

## Biến môi trường

Xem mục Day 3 trong `project/.env.example`. Các biến chính:

| Biến | Ý nghĩa |
|---|---|
| `DAY3_AI_MODE` | `openrouter` hoặc `mock` |
| `DAY3_SERVICE_RPC_URL`, `DAY3_SERVICE_MANIFEST` | settlement chain |
| `DAY3_L1_RPC_URL`, `DAY3_L1_MANIFEST` | Dispute L1 |
| `DAY3_CONFIRMATIONS`, `DAY3_L1_CONFIRMATIONS` | độ sâu confirm |
| `DAY3_CASE_EVENT` | override `CaseOpened`/`CaseStatusChanged` trên L1 |
| `DAY3_GATEWAY_CASE_EVENT` | override event Gateway (mặc định `CaseOpened`) |
| `DAY3_START_BLOCK`, `DAY3_LOOKBACK_BLOCKS` | phạm vi quét ban đầu |
| `DAY3_MAX_ATTEMPTS`, `DAY3_LEASE_SECONDS` | retry/lease |
| `DAY3_SUBMITTER_PRIVATE_KEY` | reviewer key, chỉ trong `.env` |
| `DAY3_SERVICE_AGENT_ID` | agent mà worker instance này xử lý |
| `DAY3_SERVICE_INPUT_*`, `DAY3_EVIDENCE_*` | input/evidence demo |
| `DAY3_MOCK_ELIGIBLE` | chỉ dùng local, mặc định tắt |
| `DAY3_DEBUG` | in stack trace lỗi |

`AES_KEY_HEX`, `DATABASE_URL`, `OPENROUTER_API_KEY` dùng chung với Day 1/2.
Không commit `.env`, witness, evidence hay private key.

## Giới hạn / chưa kiểm chứng

1. **Chưa chạy staging thật.** Máy hiện tại không có `.env`, PostgreSQL, RPC
   `127.0.0.1:8545`, manifest runtime hay prover toolchain. Vì vậy chỉ checklist
   phần code/migration/test được tick; mục bàn giao Ngày 3 (kịch bản A/B thật)
   vẫn chờ.
2. **Teleporter L1 → Fuji** vẫn là hạ tầng của Người 1. Worker chỉ xử lý khi
   claim đã xuất hiện trên L1; trước đó job ở `awaiting_relay`.
3. **Nguồn event:** `CaseOpened` do `MarketplaceGateway` phát trên C-Chain;
   `DisputeManager` trên L1 phát `CaseStatusChanged(Opened)` sau ingest.
   Worker hỗ trợ cả hai và tự chọn theo ABI; đây là mapping thực tế, không phải
   giả định rằng L1 có event `CaseOpened`.
4. **Role contract:** `startAnalysis`/`submitProof` chỉ cho reviewer. Submitter
   riêng phải được cấp role reviewer. Muốn tách quyền cần sửa contract.
5. **Final settlement:** worker không tự gọi `beginReview`/`decide` hay
   `sendResolution`; reviewer UI và relayer Người 1/3 tiếp tục.
6. **Reorg:** chỉ dựa vào confirmation depth; chưa có rewind checkpoint. Với
   testnet và depth ≥ 1 đủ cho demo.
7. **Evidence demo:** env/file chỉ là fallback; production nên dùng upload
   evidence đã ký và mã hóa trong PostgreSQL.
8. **Một agent mỗi worker:** `DAY3_SERVICE_AGENT_ID` giới hạn instance hiện tại;
   chạy nhiều instance với agent ID khác nhau nếu cần.
9. **Prover thật:** cần Noir `1.0.0-beta.3` + bb.js/CRS. Test offline dùng prover
   giả để kiểm tra orchestration, không tạo proof thật.

## Test

```powershell
cd project
npm.cmd run test:day3   # 19 test worker
npm.cmd run test:proof  # 7 test endpoint prepare-proof
npm.cmd run test:all    # 44 test toàn bộ phần đang có
```

Test Day 3 bao phủ:

- event key/decode, cross-check `ServicePurchased`;
- commitment, dispute window, refund cap, order/case binding;
- payout cap và zero payout;
- 15 public inputs/nullifier;
- event ledger replay, permanent/transient failure, max attempts;
- receipt + final state, retry, revert;
- executor một lần, thiếu policy, sai event;
- case pipeline, awaiting evidence, resume, idempotency;
- Gateway `CaseOpened` → `awaiting_relay` → resume sau relay;
- submitter không phải reviewer/admin/deployer, tx hash cuối cùng.

Test `prepare-proof` bao phủ: witness chỉ đọc từ DB đã mã hóa, cap payout theo
policy/escrow, ưu tiên analysis payout của worker, từ chối claim sai/case đã đóng,
từ chối public inputs lệch và không trả field riêng tư trong response.
