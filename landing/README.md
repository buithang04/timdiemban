# Trang giới thiệu Findmap (`landing/`)

Trang marketing / onboarding độc lập, phong cách gần [Winmap](https://winmap.vn/) và [ChatPlus](https://chatplus.vn/) (xanh `#2B59FF` + xanh lá `#2CC981`).

## Nội dung

- Giới thiệu hệ thống (Web + Extension + Server)
- Mục tiêu & đối tượng dùng
- Kết quả sau mỗi lần quét
- Chính sách người dùng (tóm tắt)
- Quy định vận hành / pháp lý bản đồ
- CTA đăng nhập

## Xem local

Mở file trực tiếp:

```text
landing/index.html
```

Hoặc serve thư mục (ví dụ):

```bash
npx --yes serve landing -p 5173
```

Rồi mở `http://localhost:5173`.

## Ghi chú

- Folder này **tách** khỏi `web/` app chính.
- Link CTA mặc định trỏ `/login` (cùng origin khi gắn vào server). Khi mở file `file://` có thể sửa tạm thành URL production.
