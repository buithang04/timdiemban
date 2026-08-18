# Điền Developer Console — từng ô một

Bản đồ 1-1 giữa **ô nhập trên Chrome Web Store Developer Console** và **nội dung cần dán vào**.
Dùng kèm `listing.md`, `permission-justifications.md`, `privacy-policy.md`.

Gói tải lên: `dist/findmap-extension-1.7.43.zip` (manifest ở gốc zip, không có `__MACOSX`,
đã loại `localhost`/`127.0.0.1`).

> Nút **Submit for review** chỉ sáng khi **cả ba** tab Store listing / Privacy practices /
> Distribution đều không còn ô bắt buộc bỏ trống. Thiếu một ô ở tab bất kỳ là nút mờ, và
> console không phải lúc nào cũng chỉ rõ ô nào — đó là lý do phổ biến nhất khiến nộp trượt.

---

## Tab: Package

Tải `dist/findmap-extension-1.7.43.zip`.

Nếu báo *"The version number in the manifest must be greater than X"*: sửa `version` trong
`extension/manifest.json` thành số lớn hơn X rồi chạy lại `node scripts/build-extension-release.js`.

---

## Tab: Store listing

| Ô | Nội dung |
|---|---|
| Item name | `Findmap – Tìm điểm bán` (22/75 ký tự) |
| Summary | dán khối bên dưới (103/132 ký tự) |
| Description | dán khối "Description" bên dưới |
| Category | `Workflow & Planning` |
| Language | `Vietnamese` |
| Store icon | 128×128 — đã có trong gói (`icons/icon128.png`) |
| Screenshots | **bắt buộc ≥ 1**, kích thước 1280×800 hoặc 640×400 |
| Official URL / Homepage | `https://findmap.vn` |
| Support URL | `https://findmap.vn` |

### Summary

```
Thu thập tên, địa chỉ, số điện thoại, website và vị trí điểm bán từ Google Maps rồi đồng bộ về Findmap.
```

### Description

```
Findmap giúp đội ngũ kinh doanh xây dựng danh sách điểm bán theo khu vực trực tiếp từ Google Maps.

Các chức năng chính:

- Tìm điểm bán theo một hoặc nhiều từ khóa, tâm bản đồ và bán kính.
- Thu thập tên, địa chỉ, số điện thoại, website và tọa độ công khai.
- Đồng bộ kết quả theo thời gian thực về bảng Findmap.
- Chống trùng dữ liệu và lưu checkpoint để hạn chế mất kết quả.
- Tự khôi phục khi service worker của Chrome ngủ hoặc trình duyệt được mở lại.
- Giữ màn hình và hệ thống thức trong đúng phiên quét để tránh tự khóa do thiết bị idle.
- Quét lại các điểm còn thiếu số điện thoại hoặc địa chỉ.

Tiện ích chỉ hoạt động khi người dùng chủ động bắt đầu tìm kiếm trên Findmap. Findmap mở một tab Google Maps chuyên dụng ở nền để người dùng tiếp tục làm việc ở tab khác. Tab Maps chỉ được đưa lên trước để khôi phục khi không có dữ liệu mới trong 5 phút hoặc một thao tác nền thực sự thất bại. Tiện ích không yêu cầu quyền gỡ lỗi và tự đóng tab Maps khi hoàn tất hoặc bị hủy. Yêu cầu giữ màn hình thức cũng được nhả ngay khi lượt quét tạm dừng hoặc kết thúc; tiện ích không giữ máy thức khi rảnh.
```

---

## Tab: Privacy practices

Đây là tab hay bị bỏ sót nhất. **Mọi ô dưới đây đều bắt buộc.**

### Single purpose

```
Findmap hỗ trợ người dùng đã đăng nhập thu thập thông tin điểm bán công khai từ Google Maps theo từ khóa và khu vực đã chọn, sau đó đồng bộ kết quả về tài khoản Findmap của chính họ.
```

### Permission justification — mỗi quyền một ô riêng

**storage**
```
Lưu phiên đăng nhập của tiện ích, tùy chọn người dùng, snapshot kết quả và checkpoint để phục hồi lượt quét sau khi service worker ngủ hoặc Chrome khởi động lại.
```

**scripting**
```
Kiểm tra và nạp lại các script đóng gói sẵn của Findmap trên tab Google Maps hoặc Findmap khi trang điều hướng làm mất kết nối giữa content script và service worker. Tiện ích không tải hay thực thi mã từ xa.
```

**alarms**
```
Đánh thức service worker theo chu kỳ trong lúc đang có công việc để kiểm tra checkpoint, phát hiện treo và khôi phục phiên sau khi Chrome dừng worker theo cơ chế của Manifest V3.
```

**power**
```
Ngăn màn hình tự tắt và ngăn máy tự sleep trong đúng thời gian người dùng chủ động chạy tìm kiếm hoặc quét lại, tránh việc hệ điều hành tự khóa do idle làm gián đoạn lượt quét dài. Tiện ích nhả yêu cầu này ngay khi lượt quét tạm dừng, hoàn tất, bị hủy hoặc gặp lỗi kết thúc.
```

### Host permission justification

```
https://www.google.com/maps/* — đọc thông tin điểm bán công khai hiển thị trên Google Maps theo đúng yêu cầu người dùng khởi chạy.
https://findmap.vn/* và https://www.findmap.vn/* — kết nối giao diện Findmap với tiện ích và đồng bộ kết quả vào tài khoản của chính người dùng.

Tiện ích không yêu cầu <all_urls>, không dùng wildcard toàn HTTP/HTTPS, không yêu cầu quyền debugger và không truy cập website ngoài phạm vi đã khai báo.
```

### Are you using remote code?

Chọn **No, I am not using remote code**.

Cơ sở: `scripts/build-extension-release.js` có hàm `assertNoRemoteCode()` chặn build nếu phát
hiện script từ xa, `importScripts` từ xa, dynamic import từ xa, `eval` hoặc `new Function`.

### Data usage — tick đúng các mục sau

| Loại dữ liệu | Khai | Căn cứ trong code |
|---|---|---|
| Personally identifiable information | **Có** | lưu `authUser` (thông tin tài khoản) trong `chrome.storage.local`; kết quả thu thập gồm số điện thoại/địa chỉ điểm bán |
| Authentication information | **Có** | lưu `authToken`, gửi kèm `Authorization: Bearer` tới `/api/auth/me` |
| Website content | **Có** | đọc nội dung trang danh sách Google Maps |
| Health information | Không | |
| Financial and payment information | Không | không xử lý thanh toán trong tiện ích |
| Personal communications | Không | |
| Location | Không | không dùng `navigator.geolocation`; tọa độ là của điểm bán và của khu vực do người dùng tự chọn, không phải vị trí thiết bị |
| Web history | Không | |
| User activity | Không | không ghi click/gõ phím/cuộn ngoài phạm vi vận hành lượt quét |

Sau đó tick **cả ba** ô cam kết (đều đúng với tiện ích này):

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL

```
https://findmap.vn/chinh-sach-quyen-rieng-tu
```

Đã kiểm tra 24/07/2026: URL sống, công khai, không có tường đăng nhập, có mô tả đúng dữ liệu
tiện ích xử lý.

---

## Tab: Distribution

| Ô | Giá trị |
|---|---|
| Visibility | `Public` |
| Distribution | `All regions` (hoặc chỉ Vietnam nếu chỉ phục vụ trong nước) |

---

## Trước khi bấm Submit

1. Cả ba tab không còn dấu chấm than / ô đỏ.
2. Đã có ít nhất một screenshot đúng kích thước.
3. Version trong gói lớn hơn version đang publish trên chợ.
