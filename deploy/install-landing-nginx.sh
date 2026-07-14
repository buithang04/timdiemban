#!/usr/bin/env bash
# Deploy landing lên app.findmap.vn — chạy với quyền sudo một lần:
#   bash deploy/install-landing-nginx.sh
#
# An toàn: chỉ thêm route landing → :18031; hệ tìm kiếm vẫn → :18030
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Copy nginx map + site + snippet"
cp "$ROOT/deploy/nginx-findmap-landing-map.conf" /etc/nginx/conf.d/findmap-landing-map.conf
cp "$ROOT/deploy/findmap-proxy.conf" /etc/nginx/snippets/findmap-proxy.conf
cp "$ROOT/deploy/app.findmap.vn.conf" /etc/nginx/sites-available/app.findmap.vn

echo "==> Test nginx"
nginx -t

echo "==> Reload nginx (không restart — không downtime)"
systemctl reload nginx

echo "==> Kiểm tra nhanh"
echo -n "Guest / → "
curl -s http://127.0.0.1/ -H 'Host: app.findmap.vn' | grep -o '<title>[^<]*' || true
echo -n "Logged-in / → "
curl -s http://127.0.0.1/ -H 'Host: app.findmap.vn' -H 'Cookie: findmap_session=1' | grep -o '<title>[^<]*' || true
echo ""
echo "Done. URL duy nhất: https://app.findmap.vn/"
echo "  - Chưa login → trang giới thiệu"
echo "  - Đã login   → trang tìm điểm bán"
