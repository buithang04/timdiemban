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
curl -sI http://127.0.0.1/gioi-thieu -H 'Host: app.findmap.vn' | head -5
curl -sI http://127.0.0.1/ -H 'Host: app.findmap.vn' | head -5

echo ""
echo "Done. Landing: https://app.findmap.vn/gioi-thieu"
echo "Hệ tìm kiếm: https://app.findmap.vn/ (không đổi)"
