-- phpMyAdmin SQL Dump
-- version 5.1.1
-- https://www.phpmyadmin.net/
--
-- Máy chủ: 127.0.0.1
-- Thời gian đã tạo: Th7 14, 2026 lúc 09:02 AM
-- Phiên bản máy phục vụ: 10.4.22-MariaDB
-- Phiên bản PHP: 7.3.33

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Cơ sở dữ liệu: `findmap_news`
--

-- --------------------------------------------------------

--
-- Cấu trúc bảng cho bảng `cms_tokens`
--

CREATE TABLE `cms_tokens` (
  `id` bigint(20) NOT NULL,
  `token` varchar(128) NOT NULL,
  `type` varchar(32) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `expires_at` bigint(20) NOT NULL,
  `created_at` varchar(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Đang đổ dữ liệu cho bảng `cms_tokens`
--

INSERT INTO `cms_tokens` (`id`, `token`, `type`, `user_id`, `expires_at`, `created_at`) VALUES
(1, '', 'session', 'cms_admin_1783995768832_61d35ec8', 1784600849979, '2026-07-14T02:27:29.979Z');

-- --------------------------------------------------------

--
-- Cấu trúc bảng cho bảng `cms_users`
--

CREATE TABLE `cms_users` (
  `id` varchar(64) NOT NULL,
  `full_name` varchar(255) DEFAULT NULL,
  `email` varchar(255) NOT NULL,
  `password_hash` varchar(512) NOT NULL,
  `role` varchar(20) NOT NULL DEFAULT 'editor',
  `is_active` tinyint(4) NOT NULL DEFAULT 1,
  `created_at` varchar(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Đang đổ dữ liệu cho bảng `cms_users`
--

INSERT INTO `cms_users` (`id`, `full_name`, `email`, `password_hash`, `role`, `is_active`, `created_at`) VALUES
('cms_admin_1783995768832_61d35ec8', 'CMS Admin', 'admin@findmap-news.local', 'fd61b360347dc001e949afa3ec8a5233:d34535a7b70c9f9e1978b2916efb9fcef41ef0047c3a548b09d47a7362f24ff4ad32d173928db8ca31785f3ccb2b3294862bc81c425c6db5b36a77a2c99440db', 'admin', 1, '2026-07-14T02:22:48.909Z'),
('cms_ed_1783995768914_e0e524e2', 'Editor CMS', 'editor@findmap-news.local', '9f43dd3543b1012284192afa71bf9ee6:9316ce8492af7d14238ef6dfb952fb17981d4a04cf84335e91417edc1ede56b2ca51fe9ed93fec82843f2a509b49224d7c42a5c4e49b77964d044db4279c83ec', 'editor', 1, '2026-07-14T02:22:48.990Z');

-- --------------------------------------------------------

--
-- Cấu trúc bảng cho bảng `posts`
--

CREATE TABLE `posts` (
  `id` varchar(64) NOT NULL,
  `title` varchar(500) NOT NULL,
  `slug` varchar(180) NOT NULL,
  `excerpt` text DEFAULT NULL,
  `content_html` mediumtext NOT NULL,
  `cover_image` text DEFAULT NULL,
  `category_id` varchar(64) DEFAULT NULL,
  `author_id` varchar(64) DEFAULT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'draft',
  `published_at` varchar(64) DEFAULT NULL,
  `seo_title` varchar(255) DEFAULT NULL,
  `seo_description` text DEFAULT NULL,
  `focus_keyword` varchar(255) DEFAULT NULL,
  `og_image` text DEFAULT NULL,
  `canonical_url` varchar(500) DEFAULT NULL,
  `noindex` tinyint(4) NOT NULL DEFAULT 0,
  `seo_score` int(11) NOT NULL DEFAULT 0,
  `view_count` int(11) NOT NULL DEFAULT 0,
  `created_at` varchar(64) NOT NULL,
  `updated_at` varchar(64) NOT NULL,
  `secondary_keywords` text DEFAULT NULL,
  `trashed_at` varchar(64) DEFAULT NULL,
  `url_path` varchar(120) NOT NULL DEFAULT 'tin-tuc',
  `google_seo_score` int(11) DEFAULT NULL,
  `google_performance_score` int(11) DEFAULT NULL,
  `google_psi_json` mediumtext DEFAULT NULL,
  `google_psi_checked_at` varchar(64) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Đang đổ dữ liệu cho bảng `posts`
--

INSERT INTO `posts` (`id`, `title`, `slug`, `excerpt`, `content_html`, `cover_image`, `category_id`, `author_id`, `status`, `published_at`, `seo_title`, `seo_description`, `focus_keyword`, `og_image`, `canonical_url`, `noindex`, `seo_score`, `view_count`, `created_at`, `updated_at`, `secondary_keywords`, `trashed_at`, `url_path`, `google_seo_score`, `google_performance_score`, `google_psi_json`, `google_psi_checked_at`) VALUES
('a4b832ef1f0328c3e9fd69d3', 'Bắt đầu với Findmap: 4 bước tìm điểm bán trên Google Maps', 'bat-dau-voi-findmap-4-buoc', 'Hướng dẫn nhanh: đăng nhập, cài tiện ích Chrome, chọn khu vực tìm kiếm và giữ Google Maps mở để gom danh sách điểm bán.', '\n          <h2>Findmap làm gì?</h2>\n          <p>Findmap giúp đội bán hàng tìm điểm bán trên Google Maps theo khu vực, gom kết quả về một bảng, trừ điểm sử dụng rõ ràng và xuất Excel hoặc gửi sang hệ thống ngoài khi đã cấu hình.</p>\n          <h2>4 bước để chạy lần đầu</h2>\n          <h3>1. Đăng nhập &amp; nhận điểm sử dụng</h3>\n          <p>Đăng nhập tài khoản Findmap. Điểm (credit) được cấp theo gói — mỗi điểm bán có số điện thoại sẽ trừ theo cấu hình hệ thống.</p>\n          <h3>2. Cài tiện ích Chrome</h3>\n          <p>Cài extension Findmap, mở lại tiện ích rồi vào trang làm việc để đồng bộ phiên đăng nhập.</p>\n          <h3>3. Chọn khu vực tìm kiếm</h3>\n          <p>Chọn tâm tìm, bán kính và từ khóa (ví dụ: quán cà phê, cửa hàng mẹ và bé).</p>\n          <h3>4. Giữ Google Maps mở khi đang chạy</h3>\n          <p>Hệ thống lấy dữ liệu trên Maps. Kết quả hiện trên bảng Findmap — lọc, xuất Excel hoặc gửi về site đã cấu hình.</p>\n          <h2>Tiếp theo</h2>\n          <p>Vào <strong>Cấu hình site</strong> nếu cần gửi danh sách sang Winmap hoặc webhook API khác. Quản trị viên dùng CMS để đăng hướng dẫn và tin sản phẩm tại mục Tin tức.</p>\n        ', NULL, '35db9045340974fbb9e73bd9', NULL, 'published', '2026-07-14T02:22:49.121Z', 'Bắt đầu với Findmap — tìm điểm bán trên Google Maps', 'Hướng dẫn 4 bước dùng Findmap: đăng nhập, cài tiện ích Chrome, chọn khu vực và gom điểm bán từ Google Maps về một bảng.', 'tìm điểm bán google maps', NULL, NULL, 0, 30, 0, '2026-07-14T02:22:49.121Z', '2026-07-14T02:22:49.121Z', NULL, NULL, 'tin-tuc', NULL, NULL, NULL, NULL);

-- --------------------------------------------------------

--
-- Cấu trúc bảng cho bảng `post_categories`
--

CREATE TABLE `post_categories` (
  `id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `slug` varchar(180) NOT NULL,
  `description` text DEFAULT NULL,
  `created_at` varchar(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Đang đổ dữ liệu cho bảng `post_categories`
--

INSERT INTO `post_categories` (`id`, `name`, `slug`, `description`, `created_at`) VALUES
('35db9045340974fbb9e73bd9', 'Hướng dẫn', 'huong-dan', 'Cách dùng Findmap theo từng bước', '2026-07-14T02:22:49.114Z'),
('8902b837d160802380a6b865', 'Tin sản phẩm', 'tin-san-pham', 'Cập nhật tính năng Findmap', '2026-07-14T02:22:49.116Z'),
('f549ae0d96dd069726144957', 'Kinh nghiệm', 'kinh-nghiem', 'Tips tìm điểm bán hiệu quả', '2026-07-14T02:22:49.117Z');

-- --------------------------------------------------------

--
-- Cấu trúc bảng cho bảng `settings`
--

CREATE TABLE `settings` (
  `key` varchar(255) NOT NULL,
  `value` text DEFAULT NULL,
  `updated_at` varchar(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Đang đổ dữ liệu cho bảng `settings`
--

INSERT INTO `settings` (`key`, `value`, `updated_at`) VALUES
('gsc_property_url', '', '2026-07-14T06:49:46.926Z'),
('gsc_verification_meta', '', '2026-07-14T06:49:46.922Z'),
('pagespeed_api_key', '', '2026-07-14T06:49:46.927Z'),
('seo_default_description', 'Findmap — tìm điểm bán trên Google Maps, quản lý credit và xuất danh sách.', '2026-07-14T06:49:46.932Z'),
('seo_site_name', 'Findmap', '2026-07-14T06:49:46.931Z');

--
-- Chỉ mục cho các bảng đã đổ
--

--
-- Chỉ mục cho bảng `cms_tokens`
--
ALTER TABLE `cms_tokens`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_token` (`token`),
  ADD KEY `idx_user` (`user_id`);

--
-- Chỉ mục cho bảng `cms_users`
--
ALTER TABLE `cms_users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_email` (`email`);

--
-- Chỉ mục cho bảng `posts`
--
ALTER TABLE `posts`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_post_slug` (`slug`),
  ADD KEY `idx_post_status` (`status`),
  ADD KEY `idx_post_category` (`category_id`),
  ADD KEY `idx_post_published` (`published_at`),
  ADD KEY `fk_post_author` (`author_id`);

--
-- Chỉ mục cho bảng `post_categories`
--
ALTER TABLE `post_categories`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_cat_slug` (`slug`);

--
-- Chỉ mục cho bảng `settings`
--
ALTER TABLE `settings`
  ADD PRIMARY KEY (`key`);

--
-- AUTO_INCREMENT cho các bảng đã đổ
--

--
-- AUTO_INCREMENT cho bảng `cms_tokens`
--
ALTER TABLE `cms_tokens`
  MODIFY `id` bigint(20) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- Các ràng buộc cho các bảng đã đổ
--

--
-- Các ràng buộc cho bảng `cms_tokens`
--
ALTER TABLE `cms_tokens`
  ADD CONSTRAINT `fk_cms_tokens_user` FOREIGN KEY (`user_id`) REFERENCES `cms_users` (`id`) ON DELETE CASCADE;

--
-- Các ràng buộc cho bảng `posts`
--
ALTER TABLE `posts`
  ADD CONSTRAINT `fk_post_author` FOREIGN KEY (`author_id`) REFERENCES `cms_users` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_post_category` FOREIGN KEY (`category_id`) REFERENCES `post_categories` (`id`) ON DELETE SET NULL;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
