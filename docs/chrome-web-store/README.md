# Phát hành Findmap lên Chrome Web Store

## 1. Tạo gói phát hành

```bash
node scripts/sync-app-config.js
node scripts/build-extension-release.js
```

File tải lên Chrome Web Store được tạo tại `dist/findmap-extension-<version>.zip`.
Script build tự loại `localhost`, chặn quyền toàn Internet và kiểm tra `debugger`
chỉ là quyền tùy chọn.

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
- Kiểm tra trường hợp chưa bật quyền quét nền: Maps được đưa lên trước và vẫn chạy.
- Mở popup, bật "Quét nền ổn định", chạy lại và chuyển sang tab khác.
- Trong lúc quét, bấm "service worker" > Terminate/Stop nếu Chrome cung cấp, sau đó chờ tối đa 30–60 giây và xác nhận phiên tự tiếp tục.
- Khởi động lại Chrome trong lúc quét với tùy chọn tự mở lại Maps đang bật và xác nhận checkpoint được khôi phục.
- Hoàn tất lượt quét phải đóng tab Maps, gỡ debugger và không còn alarm hoạt động.

## 4. Lưu ý duyệt chợ

Manifest V3 không hỗ trợ service worker chạy vĩnh viễn. Findmap dùng alarm, storage checkpoint
và event của tab để phục hồi. Không thêm offscreen page, WebSocket giả hoặc vòng lặp gọi API chỉ
nhằm né lifecycle vì có thể bị Chrome Web Store đánh giá là lạm dụng nền.
