# Chrome Web Store listing

## Tên

Findmap – Tìm điểm bán

## Mô tả ngắn

Thu thập tên, địa chỉ, số điện thoại, website và vị trí điểm bán từ Google Maps rồi đồng bộ về Findmap.

## Mô tả chi tiết

Findmap giúp đội ngũ kinh doanh xây dựng danh sách điểm bán theo khu vực trực tiếp từ Google Maps.

Các chức năng chính:

- Tìm điểm bán theo một hoặc nhiều từ khóa, tâm bản đồ và bán kính.
- Thu thập tên, địa chỉ, số điện thoại, website và tọa độ công khai.
- Đồng bộ kết quả theo thời gian thực về bảng Findmap.
- Chống trùng dữ liệu và lưu checkpoint để hạn chế mất kết quả.
- Tự khôi phục khi service worker của Chrome ngủ hoặc trình duyệt được mở lại.
- Giữ màn hình và hệ thống thức trong đúng phiên quét để tránh tự khóa do thiết bị idle.
- Quét lại các điểm còn thiếu số điện thoại hoặc địa chỉ.

Tiện ích chỉ hoạt động khi người dùng chủ động bắt đầu tìm kiếm trên Findmap. Findmap mở một tab
Google Maps chuyên dụng ở nền để người dùng tiếp tục làm việc ở tab khác. Tab Maps chỉ được đưa
lên trước để khôi phục khi không có dữ liệu mới trong 5 phút hoặc một thao tác nền thực sự thất bại.
Tiện ích không yêu cầu quyền gỡ lỗi và tự đóng tab Maps khi hoàn tất hoặc bị hủy.
Yêu cầu giữ màn hình thức cũng được nhả ngay khi lượt quét tạm dừng hoặc kết thúc; tiện ích không giữ máy thức khi rảnh.
