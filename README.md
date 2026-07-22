# timdiemban / Findmap

Tìm điểm bán trên Google Maps — Chrome Extension + Web tìm kiếm + Landing/CMS tin tức.

## Cấu trúc

| Folder | Vai trò |
|--------|---------|
| `extension/` | Chrome Extension MV3 |
| `web/` | Giao diện tìm kiếm + admin điểm |
| `server/` | API tìm kiếm + MySQL `timdiemban` (port 3000) |
| `landing/` | Giới thiệu + tin tức + CMS (port 3001, DB `findmap_news`) |
| `config/` | `APP_ORIGIN` / `NEWS_ORIGIN` |

## Chạy local

```bash
# 1. Hệ tìm kiếm
cd server
npm install
npm start
# → http://localhost:3000

# 2. Landing / tin / CMS
cd landing
npm install
npm start
# → http://localhost:3001/gioi-thieu
```

## Cấu hình origin (quan trọng khi deploy)

Sửa **một chỗ**: [`config/app-config.js`](config/app-config.js) + env:

| Biến | Ý nghĩa |
|------|---------|
| `APP_ORIGIN` / `SEARCH_ORIGIN` | Hệ tìm kiếm |
| `NEWS_ORIGIN` | Landing + tin + CMS |

Local (`landing/server/.env` / `server/.env`):

```
APP_ORIGIN=http://localhost:3000
SEARCH_ORIGIN=http://localhost:3000
NEWS_ORIGIN=http://localhost:3001
```

Prod: đặt cả hai về domain thật (cùng host hoặc subdomain). Chạy `node scripts/sync-app-config.js`.

Không hardcode `localhost:3001` trong HTML — link CMS/login lấy từ config / `/api/config/origins`.

## Đóng gói Chrome Extension

```bash
cd server
npm run build:extension
```

ZIP phát hành nằm trong `dist/`. Checklist, privacy policy và permission justification ở
`docs/chrome-web-store/`.
