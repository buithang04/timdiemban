# Chính sách quyền riêng tư của tiện ích Findmap

Cập nhật lần cuối: 22/07/2026

Tiện ích Findmap giúp người dùng thu thập thông tin điểm bán công khai từ Google Maps và đồng bộ
kết quả về tài khoản Findmap của họ.

## Dữ liệu được xử lý

- Thông tin tài khoản và token phiên Findmap để xác thực việc đồng bộ.
- Từ khóa, tọa độ trung tâm, bán kính và tùy chọn của lượt tìm kiếm do người dùng nhập.
- Thông tin điểm bán công khai hiển thị trên Google Maps, như tên, địa chỉ, số điện thoại,
  website, tọa độ và đường dẫn Google Maps.
- Checkpoint kỹ thuật và log tiến độ tối thiểu để phục hồi lượt quét khi Chrome tạm dừng service worker.

## Mục đích sử dụng

Dữ liệu chỉ được dùng để thực hiện chức năng tìm điểm bán, hiển thị tiến độ, khôi phục phiên,
chống mất kết quả và đồng bộ dữ liệu vào tài khoản Findmap theo yêu cầu của người dùng.

## Lưu trữ và chia sẻ

Checkpoint được lưu trong vùng lưu trữ riêng của extension trên thiết bị. Token phiên được lưu
trong vùng lưu trữ extension và vùng lưu trữ cục bộ của chính các trang Findmap để duy trì đăng nhập
và đồng bộ giữa website với tiện ích. Kết quả được gửi đến máy chủ Findmap khi người dùng sử dụng
chức năng đồng bộ. Findmap không bán dữ liệu, không dùng dữ liệu cho quảng cáo và không chia sẻ với
bên thứ ba ngoài các tích hợp mà người dùng chủ động cấu hình trong hệ thống Findmap.

## Quyền trình duyệt

Findmap chỉ truy cập Google Maps và các domain Findmap được khai báo trong manifest. Tiện ích
không yêu cầu quyền `debugger`, không đọc lịch sử duyệt web và không truy cập các website ngoài
phạm vi đã khai báo. Tab Google Maps chuyên dụng chỉ được mở khi người dùng chủ động bắt đầu quét.

## Xóa dữ liệu

Người dùng có thể đăng xuất, xóa dữ liệu kết quả trên Findmap hoặc gỡ extension để xóa dữ liệu cục
bộ của extension. Yêu cầu liên quan đến dữ liệu tài khoản có thể gửi đến đơn vị vận hành Findmap.

## Liên hệ

- Đơn vị vận hành: Công Ty TNHH An Đức Tâm.
- Email hỗ trợ: `[CẦN ĐIỀN EMAIL HỖ TRỢ CHÍNH THỨC]`.

Trước khi nộp Chrome Web Store, đăng chính sách này tại một URL HTTPS công khai thuộc `findmap.vn`
và thay placeholder email bằng địa chỉ hỗ trợ đang hoạt động.
