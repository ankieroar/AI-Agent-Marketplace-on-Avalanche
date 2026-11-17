# Kế hoạch cập nhật — 2026-11-17

Nguồn thiết kế mới: README.md ở gốc repository, do chủ dự án cập nhật. Workflow cũ tại D:/26120200/mess/workflow/avalanche_ai_agent_marketplace_workflow_vi.md chưa phản ánh thay đổi này.

- P0: marketplace curated với 1 Document Summary Service Agent, cộng 3 Dispute Agents nội bộ. Một model miễn phí có thể dùng cho cả bốn vai trò; không cần bốn model riêng.
- Luồng sản phẩm: Discover → Buy → Execute → Accept/Dispute → Settle. Buyer và Seller dùng ví khác nhau.
- Escrow P0 giữ tiền Buyer mua dịch vụ theo orderId; warranty collateral của Merchant chuyển xuống P1.
- Cần AgentRegistry và ServiceOrderManager. Service runtime chỉ chạy cho paid order đã xác thực; chống execute trùng.
- Commitment gắn order/domain/version và điều khoản disputeWindowSeconds/maxRefundWei/nonce được Seller xác nhận trước checkout. purchaseTimestamp thực lấy on-chain, không dự đoán timestamp tương lai.
- ZK refundAmountWei public phải khớp quyết định reviewer và settlement, đồng thời <= maxRefundWei và <= priceWei. Đặc tả Poseidon/field encoding cần chốt trước khi triển khai circuit thật.
- Payload CaseOpened bổ sung orderId/purchaseTimestamp; chiều trả kết quả cần exact refundAmountWei và các tham chiếu proof/approval.
- Yêu cầu phiên làm việc vẫn là chỉ API miễn phí, không paid fallback.

Code schema hiện trong packages/schema và pipeline hiện tại là prototype ngày 1 theo warranty profile cũ (ABI/Keccak, purchaseTimestamp/warrantyEndTimestamp/maxPayout). Chưa được cập nhật thành marketplace profile/Poseidon và không được dùng như thể đã tương thích với circuit mới. Bước tiếp theo cần version schema mới và fixture thống nhất TS/Noir/Solidity; không đổi âm thầm encoding cũ.

README gốc tham chiếu AVALANCHE_DISPUTE_TO_MARKETPLACE_PLAN_DAY2_DAY5.md nhưng chưa có file này trong repository khi kiểm tra. Cần chủ dự án bổ sung đúng file; không tự suy diễn lịch chi tiết.

Tình trạng hạ tầng ngày 1 và các blocker không thay đổi: xem DAY1-REPORT.md. Việc cập nhật kế hoạch không đồng nghĩa tính năng marketplace đã triển khai.
