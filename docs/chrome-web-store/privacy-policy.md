# Chính sách quyền riêng tư của tiện ích Findmap

Cập nhật lần cuối: 23/07/2026

Tiện ích Findmap giúp người dùng thu thập thông tin điểm bán công khai từ Google Maps và đồng bộ
kết quả về tài khoản Findmap của họ.

## Dữ liệu được xử lý

- Thông tin tài khoản và token phiên Findmap để xác thực việc đồng bộ.
- Từ khóa, tọa độ trung tâm, bán kính và tùy chọn của lượt tìm kiếm do người dùng nhập.
- Thông tin điểm bán công khai hiển thị trên Google Maps, như tên, danh mục, địa chỉ, số điện
  thoại, website, điểm đánh giá, số lượt đánh giá, giờ mở cửa, tọa độ và đường dẫn Google Maps.
- Checkpoint kỹ thuật và trạng thái tiến độ tối thiểu để phục hồi lượt quét khi Chrome tạm dừng
  service worker hoặc tab Maps bị đóng.

## Mục đích sử dụng

Dữ liệu chỉ được dùng để thực hiện chức năng tìm điểm bán, hiển thị tiến độ, khôi phục phiên,
chống mất kết quả và đồng bộ dữ liệu vào tài khoản Findmap theo yêu cầu của người dùng.

## Lưu trữ và chia sẻ

Checkpoint được lưu trong vùng lưu trữ riêng của extension trên thiết bị và có thể được khôi phục
trong tối đa 30 ngày kể từ lần lưu hoạt động gần nhất; checkpoint thường được xóa ngay khi lượt quét
hoàn tất, bị hủy hoặc người dùng xóa dữ liệu. Token phiên được lưu trong vùng lưu trữ extension và
vùng lưu trữ cục bộ của chính các trang Findmap để duy trì đăng nhập và đồng bộ giữa website với tiện
ích. Kết quả được gửi đến máy chủ Findmap khi người dùng sử dụng chức năng đồng bộ. Findmap không bán
dữ liệu, không dùng dữ liệu cho quảng cáo và không chia sẻ với bên thứ ba ngoài các tích hợp mà người
dùng chủ động cấu hình trong hệ thống Findmap.

## Quyền trình duyệt

Findmap chỉ truy cập Google Maps và các domain Findmap được khai báo trong manifest. Tiện ích
không yêu cầu quyền `debugger`, không đọc lịch sử duyệt web và không truy cập các website ngoài
phạm vi đã khai báo. Tab Google Maps chuyên dụng chỉ được mở khi người dùng chủ động bắt đầu quét.
Trong đúng thời gian quét, tiện ích có thể yêu cầu Chrome giữ hệ thống thức để tránh mất tiến trình
khi khóa màn hình; yêu cầu này được nhả khi hoàn tất, hủy hoặc dừng công việc Maps và không thu thập
thêm dữ liệu cá nhân.

## Xóa dữ liệu

Người dùng có thể đăng xuất, xóa dữ liệu kết quả trên Findmap hoặc gỡ extension để xóa dữ liệu cục
bộ của extension. Yêu cầu liên quan đến dữ liệu tài khoản có thể gửi đến đơn vị vận hành Findmap.

## Liên hệ

- Đơn vị vận hành: Công Ty TNHH An Đức Tâm.
- Email hỗ trợ: `business@chatplus.vn`.

URL công khai dùng cho Chrome Web Store:
`https://findmap.vn/chinh-sach-quyen-rieng-tu`.
