# Permission justifications

## Single purpose

Findmap hỗ trợ người dùng đã đăng nhập thu thập thông tin điểm bán công khai từ Google Maps
theo từ khóa và khu vực đã chọn, sau đó đồng bộ kết quả về tài khoản Findmap của chính họ.

## Required permissions

- `tabs`: tìm, mở, điều hướng và đóng tab Google Maps chuyên dụng; tìm tab Findmap để đồng bộ kết quả.
- `windows`: mở và đưa tab Google Maps chuyên dụng lên trước trong đúng cửa sổ người dùng để Chrome không tạm dừng việc render khi quét.
- `storage`: lưu phiên đăng nhập extension, tùy chọn người dùng, snapshot kết quả và checkpoint phục hồi sau khi service worker ngủ hoặc Chrome khởi động lại.
- `scripting`: kiểm tra/reinject các script đóng gói sẵn của Findmap trên tab Google Maps hoặc Findmap khi trang điều hướng làm mất kết nối. Extension không tải hay thực thi mã từ xa.
- `alarms`: đánh thức service worker theo chu kỳ 30 giây trong lúc có công việc để kiểm tra checkpoint, phát hiện treo và khôi phục phiên.

## Host access

- `https://www.google.com/maps/*`: đọc thông tin điểm bán công khai trong Google Maps theo yêu cầu người dùng.
- `https://findmap.vn/*`, `https://www.findmap.vn/*`, `https://app.findmap.vn/*`: kết nối giao diện Findmap với extension và đồng bộ kết quả vào tài khoản người dùng.

Bản ZIP phát hành không chứa `debugger`, `<all_urls>`, wildcard toàn HTTP/HTTPS hoặc quyền localhost.
