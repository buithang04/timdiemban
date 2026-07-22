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

Checkpoint và token phiên được lưu trong vùng lưu trữ riêng của extension trên thiết bị. Kết quả
được gửi đến máy chủ Findmap khi người dùng sử dụng chức năng đồng bộ. Findmap không bán dữ liệu,
không dùng dữ liệu cho quảng cáo và không chia sẻ với bên thứ ba ngoài các tích hợp mà người dùng
chủ động cấu hình trong hệ thống Findmap.

## Quyền trình duyệt

Findmap chỉ truy cập Google Maps và các domain Findmap được khai báo trong manifest. Quyền
`debugger` là tùy chọn, chỉ được xin sau thao tác rõ ràng của người dùng và chỉ áp dụng cho tab
Google Maps của lượt quét nhằm duy trì xử lý khi tab nằm nền.

## Xóa dữ liệu

Người dùng có thể đăng xuất, xóa dữ liệu kết quả trên Findmap hoặc gỡ extension để xóa dữ liệu cục
bộ của extension. Yêu cầu liên quan đến dữ liệu tài khoản có thể gửi đến đơn vị vận hành Findmap.

## Liên hệ

Trước khi công bố, thay đoạn này bằng email hỗ trợ chính thức và thông tin pháp nhân/đơn vị vận hành
Findmap. Chính sách này phải được đăng tại một URL HTTPS công khai thuộc `findmap.vn`.
