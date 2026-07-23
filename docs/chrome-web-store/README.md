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
- Chạy tìm kiếm; xác nhận tab Maps chuyên dụng được đưa lên trước đúng một lần khi bắt đầu lấy danh sách URL của mỗi khu vực hoặc khi retry lỗi; chunk tiếp tục cùng khu vực không giành lại focus.
- Chuyển sang tab khác trong lúc lấy danh sách; xác nhận Findmap hiện cảnh báo và không kéo Maps trở lại liên tục. Quay lại Maps để tiếp tục lấy đủ danh sách.
- Chuyển sang tab khác trong giai đoạn đọc chi tiết URL; xác nhận thao tác đổi URL và đọc thông tin vẫn tiếp tục ở nền.
- Mô phỏng Maps không phản hồi; xác nhận tab không được đưa lên trước trong 5 phút đầu và chỉ focus một lần để khôi phục sau ngưỡng này hoặc khi thao tác thực sự thất bại.
- Trong lúc quét, bấm "service worker" > Terminate/Stop nếu Chrome cung cấp, sau đó chờ tối đa 30–60 giây và xác nhận phiên tự tiếp tục.
- Khóa màn hình 15–30 phút nhưng không đóng nắp/không chọn Sleep; xác nhận số URL hoặc URL chi tiết tiếp tục tăng và máy không tự chuyển sang system sleep.
- Dừng hoặc hoàn tất lượt quét; xác nhận extension đã nhả `power` keep-awake và máy có thể tự sleep bình thường trở lại.
- Khởi động lại Chrome trong lúc quét với tùy chọn tự mở lại Maps đang bật và xác nhận checkpoint được khôi phục.
- Hoàn tất lượt quét phải đóng tab Maps và không còn alarm công việc hoạt động.

## 4. Lưu ý duyệt chợ

Manifest V3 không hỗ trợ service worker chạy vĩnh viễn và không bảo đảm tab nền luôn render.
Findmap đưa Maps lên trước một lần khi bắt đầu lấy danh sách URL của mỗi khu vực hoặc khi retry lỗi, sau đó
không giành lại focus nếu người dùng đổi tab. Alarm, storage checkpoint và event của tab dùng để
phục hồi; ngoài lần bắt đầu pha list, Maps chỉ tự quay lại khi không có dữ liệu mới trong 5 phút
hoặc thao tác nền thất bại.
Pha cuộn dài được chia thành các chunk dưới 5 phút, lưu URL đã gom vào checkpoint rồi tiếp tục
cùng ô. Chunk còn phát sinh URL không bị tính là retry lỗi. Trong đúng thời gian thao tác do người
dùng khởi chạy, extension yêu cầu Chrome giữ hệ thống thức và background gửi wake message có giới
hạn để timer của tab ẩn tiếp tục tiến. Cả power request và wake pulse đều dừng khi công việc Maps
kết thúc hoặc được đưa về trạng thái chờ phục hồi. Không thêm debugger, offscreen page,
AudioContext/WebSocket giả hoặc keepalive chạy vĩnh viễn.

## 5. Quy tắc version

- `1.0.0` chỉ dùng khi tạo listing Chrome Web Store mới.
- Nếu listing đã từng phát hành `1.0.3`, bản tiếp theo phải lớn hơn, ví dụ `1.0.4`; Chrome Web Store không cho hạ version.
