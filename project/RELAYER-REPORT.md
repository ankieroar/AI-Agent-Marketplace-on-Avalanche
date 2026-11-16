# Kiểm tra relayer và xác nhận nhận message

## Kết luận

Lỗi `-32601: the method eth_newFilter is not available` trong ảnh là lỗi đăng ký theo dõi event: RPC không cung cấp method này. Nó không chứng minh RPC ngừng hoạt động hay giao dịch gửi thất bại. Theo tài liệu ethers, `polling: true` dùng polling ngay thay vì thử tạo filter: https://docs.ethers.org/v6/api/providers/jsonrpc/.

`npm run ping` chỉ chờ receipt trên Fuji, không chờ receipt Dispute L1. Vì vậy thông báo success cũ gây hiểu nhầm. File relayer trong workspace hiện đã dùng queryFilter/eth_getLogs, khác với cơ chế gây lỗi trong ảnh; không thể khẳng định ảnh được tạo bởi đúng phiên bản hiện tại.

## Các thay đổi

- Bật polling rõ ràng ở cả hai provider; quét eth_getLogs từng tối đa 100 block.
- Hiển thị lỗi RPC và retry, giữ nguyên vị trí quét khi giao thất bại.
- Chỉ đánh dấu đã xử lý sau receipt thành công có event PongReceived từ đúng receiver.
- Lọc đúng blockchain đích và receiver; với lệnh ping trực tiếp từ ví, lấy caller từ giao dịch nguồn thay vì gán ví relayer.
- Sửa thông báo script ping để chỉ xác nhận phía nguồn; thêm `npm run delivery` để đọc trạng thái hoặc kiểm chứng receipt L1.

## Bằng chứng đọc trực tiếp từ L1

RPC trả chain ID `662831`. Contract `0x83620E38fcDF5BF361494932dA91261C006C64d3` có `totalReceivedMessages = 1`.

Receipt L1 đã được kiểm tra thành công, có PongReceived từ đúng contract:

- Tx: `0x3296c088f88e44620d1369f432693b1f1a3cdeb3eb7baf0800c6cef83e0ce634`
- Block: `3`
- Origin sender: `0x82897b63bba2Bab3D43Ed9Ccc4A0EF8321d6d8d6`
- Initial caller: `0x342482d83aB3E03745a96dc377aF806D19726Fa7`
- Message: `CaseOpened: Order #001 warranty claim verified via Teleporter`
- Sent timestamp: `1794727962`; received timestamp: `1794728001`.

Đây là bằng chứng đã nhận một message test. Chưa đối chiếu được riêng giao dịch Fuji trong ảnh: cùng nội dung không đồng nghĩa cùng lần gửi. Event đích hiện không lưu source tx hash hay message ID để liên kết trực tiếp.

## Cách chạy và kiểm tra

Từ thư mục gốc repository, terminal thứ nhất:

```powershell
node project/services/relayer-monitor/relayer.js
```

Terminal thứ hai:

```powershell
cd project/contracts
npm run ping
npm run delivery
```

Relayer phải in hash giao dịch **Dispute L1** và SUCCESS sau khi receipt có PongReceived. Dùng hash L1 đó:

```powershell
npm run delivery -- 0x3296c088f88e44620d1369f432693b1f1a3cdeb3eb7baf0800c6cef83e0ce634
```

`VERIFIED PongReceived` xác nhận giao dịch L1 thành công và receiver đã phát event. Đối chiếu origin sender, caller, messageText và sentTimestamp với lần gửi nguồn. Chạy không kèm hash chỉ đọc tổng số và message cuối; không chứng minh riêng một lần gửi.

## Giới hạn còn lại

Daemon này là fallback được cấp quyền: ký giao dịch gọi trực tiếp receiveTeleporterMessage. Nó không phải relayer AWM/ICM chính thức và receipt này không chứng minh BLS/Warp verification. Không cần deploy lại contract cho bản sửa hiện tại.

Danh sách chống trùng chỉ nằm trong RAM, contract chưa chống replay. Khởi động lại có thể gửi trùng các message trong 30 block gần nhất. Không tự ý quét lại lịch sử đã nhận. Có thể đặt `RELAYER_FROM_BLOCK` trong project/.env để bắt đầu từ block Fuji đã xác định chưa xử lý; cần xác minh trước vì replay có thể tăng bộ đếm lần nữa. Nếu tx đã broadcast nhưng mất kết nối khi chờ receipt, kiểm tra hash L1 trước khi retry. Caller lấy từ tx.from chỉ phù hợp luồng gọi PingSender trực tiếp từ ví như script hiện tại.

Đã kiểm tra cú pháp các file JS thay đổi và chạy lệnh delivery với receipt thật ở trên. Chưa gửi giao dịch test mới và chưa kiểm thử end-to-end bản relayer sửa trên mạng thật.
