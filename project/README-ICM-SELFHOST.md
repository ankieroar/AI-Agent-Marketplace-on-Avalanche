# ICM tự host — ping/pong hai chiều V2

**Cập nhật:** [báo cáo mới nhất](docs/DAY1-LATEST-STATUS.md) ghi nhận chiều Fuji → L1 đã xác thực thành công qua Warp và L1 tự phát pong. Chiều về chưa nhận ở Fuji. Discovery công khai ghi validator tại IP nội bộ 10.146.2.83:9651. Snapshot thử P2P ban đầu bên dưới vẫn giữ để đối chiếu.

## Trạng thái kiểm chứng

- Đã tải relayer chính thức ava-labs/icm-services v1.8.4, xác minh SHA256 release và build image local. License của relayer theo repository upstream; giữ thông báo bản quyền khi phân phối. Docker Desktop có điều kiện license theo tổ chức; không sử dụng dịch vụ cloud trả phí.
- Đã compile và pass 3 test Solidity local, trong đó 2 test V2 dùng mock Messenger để kiểm tra logic callback, automatic reply, nguồn và replay. Mock tests không chứng minh chữ ký Warp.
- Đã deploy V2 trên hai chain và cấp gas testnet cho ví relayer riêng. Các contract cũ không phải proxy, không thể tự thay bytecode; deploy V2 giữ lại lịch sử cũ.
- Đã thực sự chạy official relayer. Fuji kết nối đủ quorum; L1 báo connectedWeight=0/100, numConnectedPeers=0 rồi timeout. Chưa có vòng ICM V2 thành công, chưa gửi ping V2 vì relayer chưa ready.
- Cần IP:port P2P công khai của validator L1, đồng thời node phải cho phép kết nối P2P và phục vụ chữ ký Warp. RPC HTTPS không thay thế địa chỉ P2P. Không có cách sửa endpoint ứng dụng để bỏ qua điều kiện chữ ký mà vẫn gọi đó là ICM thật.

## Luồng mới

Fuji PingSenderV2.sendPing → TeleporterMessenger/Warp → official relayer → L1 PongReceiverV2.receiveTeleporterMessage → tự gọi replyPong → TeleporterMessenger/Warp trên L1 → official relayer → Fuji PingSenderV2.receiveTeleporterMessage.

Receiver chỉ nhận từ Messenger cấu hình, kiểm tra chain và peer đã khóa. RoundTripId ràng buộc yêu cầu/phản hồi, chặn nhận lặp. Không gọi receiver trực tiếp từ ví relayer. Auto-reply không tạo ping-pong vô hạn vì request/reply có cờ phân biệt. Có thể tắt autoReply bằng owner để debug và gọi replyPong cho ping đã nhận; không thể reply dữ liệu chưa được xác thực.

## Cài và chạy

Dùng Node 22, Docker Desktop đang hoạt động. Từ project/contracts:

```powershell
npm run icm:install
npm run icm:prepare
```

Install tải binary Linux AMD64 pinned và kiểm tra checksum, sau đó build image warranty-icm:1.8.4. Không gửi private key trong command line. Prepare deploy nếu chưa có manifest, khóa peer, tạo ví signer riêng và nạp đủ tối đa mức balance mục tiêu 0.03 AVAX Fuji / 0.2 DISP từ ví PRIVATE_KEY. Chặn chain ID ngoài 43113/662831. Không dùng mainnet.

Nếu auto-discovery không tìm được validator L1, thêm vào project/.env:

```dotenv
L1_VALIDATOR_NODE_ID=NodeID-Fvet9DW7LD65DL8ek1de49xBXUiJJgEt4
L1_VALIDATOR_P2P=<IP_CONG_KHAI>:9651
```

Đây là thông tin công khai, không phải private key. Thay port nếu node dùng port khác. Không lấy IP từ tên miền reverse proxy RPC để đoán port P2P. Cần operator mở port/advertise public IP nếu chưa có.

Một lệnh kiểm thử toàn vòng sau setup:

```powershell
npm run icm:roundtrip
```

Lệnh kiểm tra health, khởi động official relayer nếu chưa chạy, gửi ping khi ready, chờ nhận tại L1 và pong tự phát về Fuji. Chỉ báo VERIFIED REAL ICM BOTH DIRECTIONS nếu cả hai Messenger.messageReceived=true và có event ứng dụng tương ứng. Giới hạn chờ hữu hạn; nếu hết thời gian sẽ báo pending/error, không tự fallback. Các vòng đã gửi được lưu và kiểm tra tiếp khi chạy lại. Nếu mất kết nối ngay sau broadcast mà trước khi ghi file, kiểm tra tx trên chain trước khi chạy lại để tránh tạo thêm vòng ngoài ý muốn.

## Chạy daemon riêng

```powershell
node project/services/relayer-monitor/relayer.js
```

Lệnh trên chạy từ repo root; relayer.js hiện là launcher official binary, cấu hình cả hai source/destination chains. Token signer chỉ dùng trong relayer, không dùng ký giao dịch deploy hoặc test để tránh xung đột nonce. Nếu test tự khởi động daemon thì nó dừng container đó lúc kết thúc; nếu bạn đã chạy daemon riêng thì test giữ nguyên daemon.

Bản cũ được giữ ở fallback-relayer.js và phát cảnh báo LEGACY FALLBACK. Không dùng nó để nghiệm thu ICM.

## Artifacts và secrets

- docs/icm-v2.json: địa chỉ, block deploy, tx/message IDs và trạng thái các vòng (công khai).
- .runtime/icm/signer.json và relay.env: private key mới, tuyệt đối không commit/chia sẻ.
- .runtime/icm/config.json: cấu hình sinh tự động; native relayer lưu checkpoint ở .runtime/icm/state.
- .tools/icm-relayer-1.8.4: binary/toolchain; gitignore.
- Không xóa signer.json hoặc checkpoint khi daemon đang chạy.

## Địa chỉ testnet đã deploy

- PingSenderV2 (Fuji): 0x29554794174b554c46Fe59040FeD64Bd3188B8a3
- PongReceiverV2 (L1): 0xcE7F4b616e173463C8f501bcf2B220f49771Dd3B
- Relayer signer: 0x34E719fB60cC9902C27887f8324395ED785309Fb

Nguồn chính thức: https://github.com/ava-labs/icm-services/blob/icm-relayer-v1.8.4/relayer/README.md . Muốn self-host thành công vẫn cần khả năng kết nối validator, không chỉ API eth_getLogs.

