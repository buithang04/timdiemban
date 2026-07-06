# timdiemban

Tìm điểm bán trên Google Maps — Chrome Extension + Web + Server Node.js.

## Cấu trúc

- `extension/` — Chrome Extension MV3 (quét Google Maps)
- `web/` — Giao diện kết quả (Vanilla JS + Leaflet)
- `server/` — API Node.js + MySQL
- `config/` — Cấu hình deploy (`app-config.js`)

## Chạy local

```bash
cd server
npm install
npm start
```

Mở `http://localhost:3000`, cài extension từ thư mục `extension/`.

## Cấu hình

- Copy `server/.env.example` thành `server/.env` (không commit file `.env`)
- Chỉnh domain/IP: `node scripts/sync-app-config.js`
