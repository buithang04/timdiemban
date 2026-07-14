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

## Cấu hình

- Copy `server/.env.example` → `server/.env`
- Copy `landing/server/.env.example` → `landing/server/.env`
- Domain: sửa `config/app-config.js` rồi `node scripts/sync-app-config.js`
