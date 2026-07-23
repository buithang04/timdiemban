# Permission justifications

## Single purpose

Findmap hỗ trợ người dùng đã đăng nhập thu thập thông tin điểm bán công khai từ Google Maps
theo từ khóa và khu vực đã chọn, sau đó đồng bộ kết quả về tài khoản Findmap của chính họ.

## Required permissions

- `storage`: lưu phiên đăng nhập extension, tùy chọn người dùng, snapshot kết quả và checkpoint phục hồi sau khi service worker ngủ hoặc Chrome khởi động lại.
- `scripting`: kiểm tra/reinject các script đóng gói sẵn của Findmap trên tab Google Maps hoặc Findmap khi trang điều hướng làm mất kết nối. Extension không tải hay thực thi mã từ xa.
- `alarms`: đánh thức service worker theo chu kỳ 30 giây trong lúc có công việc để kiểm tra checkpoint, phát hiện treo và khôi phục phiên sau khi Chrome dừng worker.
- `power`: ngăn màn hình tự tắt và ngăn máy tự sleep trong đúng thời gian người dùng chủ động chạy tìm kiếm hoặc quét lại, nhờ đó tránh macOS tự khóa do màn hình idle. Extension nhả yêu cầu giữ màn hình ngay khi lượt quét tạm dừng, hoàn tất, bị hủy, gặp lỗi terminal hoặc được đưa về checkpoint chờ phục hồi.

API `chrome.tabs` và `chrome.windows` chỉ được dùng để quản lý tab Google Maps/Findmap trên các
host đã khai báo. Chrome không yêu cầu permission riêng cho các thao tác quản lý tab/cửa sổ này;
extension đưa Maps lên trước một lần khi bắt đầu lấy danh sách URL của mỗi khu vực hoặc khi retry lỗi. Nếu người
dùng đổi tab, extension chỉ cảnh báo chứ không giành focus liên tục; Maps chỉ tự quay lại thêm khi
không có dữ liệu mới trong 5 phút hoặc thao tác nền thực sự lỗi.

## Host access

- `https://www.google.com/maps/*`: đọc thông tin điểm bán công khai trong Google Maps theo yêu cầu người dùng.
- `https://findmap.vn/*`, `https://www.findmap.vn/*`: kết nối giao diện Findmap với extension và đồng bộ kết quả vào tài khoản người dùng.

Bản ZIP phát hành không chứa `debugger`, `<all_urls>`, wildcard toàn HTTP/HTTPS hoặc quyền localhost.
Tiện ích không yêu cầu quyền `tabs`; việc đọc URL chỉ áp dụng trên các host Findmap/Google Maps đã
được khai báo rõ trong `host_permissions`.
