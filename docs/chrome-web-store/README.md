# Phát hành Findmap lên Chrome Web Store

## 1. Tạo gói phát hành

```bash
node scripts/sync-app-config.js
node scripts/build-extension-release.js
```

File tải lên Chrome Web Store được tạo tại `dist/findmap-extension-<version>.zip`.
Script build tự loại `localhost`, chặn quyền toàn Internet và từ chối gói phát hành
nếu còn quyền `debugger`.

## 2. Chuẩn bị Developer Dashboard

1. Tạo item mới và tải file ZIP lên.
2. Dùng nội dung trong `listing.md` cho phần mô tả.
3. Dùng `permission-justifications.md` để khai báo single purpose và giải trình quyền.
4. Đăng `privacy-policy.md` thành một URL HTTPS công khai trên `findmap.vn`, rồi nhập URL đó vào dashboard.
5. Chuẩn bị ảnh chụp giao diện thật, icon và promotional images theo kích thước dashboard đang yêu cầu.
6. Trong Privacy practices, chỉ khai báo các loại dữ liệu thực sự xử lý và khẳng định không bán dữ liệu.
7. Sau khi item có URL chính thức, đặt `EXTENSION_INSTALL_URL` trong cấu hình deploy rồi chạy lại `node scripts/sync-app-config.js` để nút cài đặt trên website trỏ đúng Chrome Web Store.

## 3. Kiểm tra thủ công trước khi nộp

- Cài ZIP bằng `chrome://extensions` ở Developer mode.
- Đăng nhập Findmap, chạy một lượt tìm kiếm ngắn và một lượt nhiều khu vực.
- Chạy tìm kiếm; xác nhận tab Maps chuyên dụng mở ở nền và không giành focus khi vẫn có dữ liệu mới.
- Chuyển sang tab khác; xác nhận thao tác cuộn, đổi URL và đọc chi tiết trên Maps vẫn tiếp tục ở nền.
- Mô phỏng Maps không phản hồi; xác nhận tab không được đưa lên trước trong 5 phút đầu và chỉ focus một lần để khôi phục sau ngưỡng này hoặc khi thao tác thực sự thất bại.
- Trong lúc quét, bấm "service worker" > Terminate/Stop nếu Chrome cung cấp, sau đó chờ tối đa 30–60 giây và xác nhận phiên tự tiếp tục.
- Khởi động lại Chrome trong lúc quét với tùy chọn tự mở lại Maps đang bật và xác nhận checkpoint được khôi phục.
- Hoàn tất lượt quét phải đóng tab Maps và không còn alarm công việc hoạt động.

## 4. Lưu ý duyệt chợ

Manifest V3 không hỗ trợ service worker chạy vĩnh viễn và không bảo đảm tab nền luôn render.
Findmap ưu tiên chạy Maps ở nền, dùng alarm, storage checkpoint và event của tab để phục hồi;
chỉ đưa Maps lên trước tạm thời khi không có dữ liệu mới trong 5 phút hoặc thao tác nền thất bại.
Pha cuộn dài được chia thành các chunk dưới 5 phút, lưu URL đã gom vào checkpoint rồi tiếp tục
cùng ô. Trong đúng thời gian thao tác do người dùng khởi chạy, background gửi wake message có giới
hạn để timer của tab ẩn tiếp tục tiến; pulse dừng ngay khi chunk/URL hoàn tất và không chạy khi rảnh.
Không thêm debugger, offscreen page, AudioContext/WebSocket giả hoặc keepalive chạy vĩnh viễn.

## 5. Quy tắc version

- `1.0.0` chỉ dùng khi tạo listing Chrome Web Store mới.
- Nếu listing đã từng phát hành `1.0.3`, bản tiếp theo phải lớn hơn, ví dụ `1.0.4`; Chrome Web Store không cho hạ version.
