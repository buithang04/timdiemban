# Findmap Landing — giới thiệu + tin tức + CMS

Một folder duy nhất cho trang công khai / tin / CMS. Hệ tìm kiếm nằm ở `server/` + `web/` (riêng).

## Cấu trúc

```
landing/
  index.html, styles.css, script.js, news-fx.js, assets/   # trang giới thiệu
  web/
    login.html          # đăng nhập CMS riêng
    tin-tuc/            # trang tin + CMS
    media/              # ảnh/video
  server/               # Express port 3001, DB findmap_news
  config/app-config.js
  package.json
```

## Chạy

```bash
cd landing
npm install
npm start
```

- Giới thiệu: http://localhost:3001/gioi-thieu
- Tin tức: http://localhost:3001/tin-tuc
- CMS: http://localhost:3001/admin-post-article
- Login CMS: http://localhost:3001/login

## Database

DB riêng: `findmap_news` (không dùng chung `timdiemban`).

```bash
cd landing
npm run migrate-from-search
# PowerShell:
$env:CONFIRM_PURGE="yes"; npm run purge-search-cms
```

## Hai hệ thống

| | Tìm kiếm | Landing / tin |
|--|--|--|
| Folder | `server/` + `web/` | `landing/` |
| Port | 3000 | 3001 |
| DB | `timdiemban` | `findmap_news` |
| Login | `/login` | `landing` `/login` |
