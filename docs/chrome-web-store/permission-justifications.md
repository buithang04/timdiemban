# Permission justifications

## Single purpose

Findmap hỗ trợ người dùng đã đăng nhập thu thập thông tin điểm bán công khai từ Google Maps
theo từ khóa và khu vực đã chọn, sau đó đồng bộ kết quả về tài khoản Findmap của chính họ.

## Required permissions

- `tabs`: tìm, mở, điều hướng và đóng tab Google Maps chuyên dụng; tìm tab Findmap để đồng bộ kết quả.
- `windows`: đưa tab Google Maps lên trước khi chế độ quét nền không khả dụng và giữ tab trong đúng cửa sổ người dùng.
- `storage`: lưu phiên đăng nhập extension, tùy chọn người dùng, snapshot kết quả và checkpoint phục hồi sau khi service worker ngủ hoặc Chrome khởi động lại.
- `scripting`: kiểm tra/reinject các script đóng gói sẵn của Findmap trên tab Google Maps hoặc Findmap khi trang điều hướng làm mất kết nối. Extension không tải hay thực thi mã từ xa.
- `alarms`: đánh thức service worker theo chu kỳ 30 giây trong lúc có công việc để kiểm tra checkpoint, phát hiện treo và khôi phục phiên.

## Optional permission

- `debugger`: chỉ được xin khi người dùng bấm "Bật chế độ này" trong popup. Findmap chỉ attach vào tab Google Maps do lượt quét tạo ra, dùng Chrome DevTools Protocol để giữ lifecycle trang ở trạng thái active và duy trì render khi tab nằm nền. Findmap không đọc network log, console, cookie hoặc nội dung tab khác. Permission được dùng trong lượt quét và debugger được detach ngay khi hoàn tất, hủy hoặc lỗi.

## Host access

- `https://www.google.com/maps/*`: đọc thông tin điểm bán công khai trong Google Maps theo yêu cầu người dùng.
- `https://findmap.vn/*`, `https://www.findmap.vn/*`, `https://app.findmap.vn/*`: kết nối giao diện Findmap với extension và đồng bộ kết quả vào tài khoản người dùng.

Bản ZIP phát hành không chứa `<all_urls>`, wildcard toàn HTTP/HTTPS hoặc quyền localhost.
