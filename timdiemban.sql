-- phpMyAdmin SQL Dump
-- version 5.1.1
-- https://www.phpmyadmin.net/
--
-- Máy chủ: 127.0.0.1
-- Thời gian đã tạo: Th7 08, 2026 lúc 09:40 AM
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
-- Cơ sở dữ liệu: `timdiemban`
--

-- --------------------------------------------------------

--
-- Cấu trúc bảng cho bảng `packages`
--

CREATE TABLE `packages` (
  `id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `points` int(11) NOT NULL,
  `price` int(11) NOT NULL DEFAULT 0,
  `expire_days` int(11) NOT NULL DEFAULT 30,
  `is_active` tinyint(4) NOT NULL DEFAULT 1,
  `created_at` varchar(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Đang đổ dữ liệu cho bảng `packages`
--

INSERT INTO `packages` (`id`, `name`, `points`, `price`, `expire_days`, `is_active`, `created_at`) VALUES
('pkg_10000', 'Gói 10.000 điểm', 10000, 279000, 365, 0, '2026-07-01T09:26:24.444Z'),
('pkg_3000', 'Gói 3.000 điểm', 3000, 99000, 365, 0, '2026-07-01T09:26:24.444Z'),
('pkg_5000', 'Gói 5.000 điểm', 5000, 149000, 365, 0, '2026-07-01T09:26:24.444Z'),
('pkg_advanced', 'Gói Advanced', 150000, 6750000, 120, 1, '2026-07-07T07:34:48.676Z'),
('pkg_basic', 'Gói Basic', 60000, 3200000, 60, 1, '2026-07-07T07:34:48.676Z'),
('pkg_starter', 'Gói Starter', 30000, 2000000, 30, 1, '2026-07-07T07:34:48.676Z');

-- --------------------------------------------------------

--
-- Cấu trúc bảng cho bảng `package_orders`
--

CREATE TABLE `package_orders` (
  `id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `package_id` varchar(64) NOT NULL,
  `points` int(11) NOT NULL,
  `payment_amount` int(11) NOT NULL DEFAULT 0,
  `status` varchar(20) NOT NULL DEFAULT 'pending',
  `payment_confirmed` tinyint(4) NOT NULL DEFAULT 0,
  `payment_confirmed_at` varchar(64) DEFAULT NULL,
  `admin_id` varchar(64) DEFAULT NULL,
  `admin_note` text DEFAULT NULL,
  `created_at` varchar(64) NOT NULL,
  `reviewed_at` varchar(64) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Đang đổ dữ liệu cho bảng `package_orders`
--

INSERT INTO `package_orders` (`id`, `user_id`, `package_id`, `points`, `payment_amount`, `status`, `payment_confirmed`, `payment_confirmed_at`, `admin_id`, `admin_note`, `created_at`, `reviewed_at`) VALUES
('ord_1782898447039_29338037', 'u_1782898429231_1586eee8', 'pkg_3000', 3000, 99000, 'approved', 1, '2026-07-01T09:34:18.072Z', 'u_admin_1782897984459_aac73701', NULL, '2026-07-01T09:34:07.039Z', '2026-07-01T09:37:38.393Z'),
('ord_1783410008630_d13c1cbc', 'u_1782898429231_1586eee8', 'pkg_starter', 30000, 2000000, 'approved', 1, '2026-07-07T07:40:27.323Z', 'u_admin_1782897984459_aac73701', NULL, '2026-07-07T07:40:08.630Z', '2026-07-07T07:42:01.973Z'),
('ord_1783415988139_0f71e7ce', 'u_1782898429231_1586eee8', 'pkg_basic', 60000, 3200000, 'rejected', 1, '2026-07-07T09:19:53.962Z', 'u_admin_1782897984459_aac73701', 'doe thic', '2026-07-07T09:19:48.139Z', '2026-07-07T09:20:36.062Z');

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
('credit_per_point', '3', '2026-07-07T08:58:33.568Z'),
('smtp_client_hostname', '', '2026-07-07T08:58:33.575Z'),
('smtp_from_email', 'dangvanbinh11012003@gmail.com', '2026-07-07T08:58:33.574Z'),
('smtp_from_name', 'findmap', '2026-07-07T08:58:33.575Z'),
('smtp_helo', '', '2026-07-07T08:58:33.576Z'),
('smtp_host', 'smtp.gmail.com', '2026-07-07T08:58:33.569Z'),
('smtp_host_backup', 'smtp.gmail.com', '2026-07-07T08:58:33.570Z'),
('smtp_password', 'fbrnvxcqqfnlxpiy', '2026-07-07T08:58:33.573Z'),
('smtp_port', '465', '2026-07-07T08:58:33.571Z'),
('smtp_reroute_address', '', '2026-07-07T08:58:33.577Z'),
('smtp_secure_mode', 'ssl', '2026-07-07T08:58:33.571Z'),
('smtp_username', 'dangvanbinh11012003@gmail.com', '2026-07-07T08:58:33.572Z'),
('vietqr_account_name', 'BUI XUAN THANG', '2026-07-01T10:01:36.825Z'),
('vietqr_account_no', '1905200419', '2026-07-01T10:01:36.824Z'),
('vietqr_acq_id', '970422', '2026-07-01T09:59:07.462Z'),
('vietqr_api_key', 'bf07b9d2-3b82-49a8-91fb-776699c2668a', '2026-07-01T09:59:07.460Z'),
('vietqr_bank_id', 'MBB', '2026-07-01T10:01:36.822Z'),
('vietqr_client_id', '328c79db-e80f-447f-b971-5dc67eabcfa9', '2026-07-01T09:59:07.458Z'),
('winmap_site_label:u_1782898429231_1586eee8', '', '2026-07-07T02:48:58.180Z'),
('winmap_site_token:u_1782898429231_1586eee8', 'jRKOsIVBEmRCKMwTGOrQ-sp8ZnA_zPKdQeVzEQQg9do', '2026-07-07T02:48:58.183Z'),
('winmap_site_url:u_1782898429231_1586eee8', 'https://newcode.winmap.vn/', '2026-07-07T02:48:58.170Z');

-- --------------------------------------------------------

--
-- Cấu trúc bảng cho bảng `tokens`
--

CREATE TABLE `tokens` (
  `id` bigint(20) NOT NULL,
  `token` varchar(128) NOT NULL,
  `type` varchar(32) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `expires_at` bigint(20) NOT NULL,
  `created_at` varchar(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Đang đổ dữ liệu cho bảng `tokens`
--

INSERT INTO `tokens` (`id`, `token`, `type`, `user_id`, `expires_at`, `created_at`) VALUES
(1, '7fbcdc3e65901dc4f3efddd32350acf56430c2dff5089204511bb038d32a045c', 'session', 'u_admin_1782897984459_aac73701', 1783503054785, '2026-07-01T09:30:54.785Z'),
(2, 'c93f8e5e8f2b8b8880f0cb0525c22e519dfd34c5014269fc634b2297669432f7', 'session', 'u_admin_1782897984459_aac73701', 1783503189415, '2026-07-01T09:33:09.415Z'),
(3, '5c099bfd9329b05603cc32d61704deac4ccb14f22be7894fe6ec3d2f031eb523', 'session', 'u_admin_1782897984459_aac73701', 1783503214039, '2026-07-01T09:33:34.039Z'),
(4, '64c449070b6f1b5da66dc1b8eda4f18d1c5a47a04d98738a44d880b639d64ae8', 'session', 'u_1782898429231_1586eee8', 1783503240253, '2026-07-01T09:34:00.253Z'),
(5, 'c230f9075239bfbf694ea62716fae1d0945b429f7af43e1cae29c1ac1e752b6d', 'session', 'u_1782898429231_1586eee8', 1783503470183, '2026-07-01T09:37:50.183Z'),
(6, 'ea8cecb96c1b9691ded25d1a565d04396266a6f0509d4736855e7695610dace9', 'session', 'u_1782898429231_1586eee8', 1783503707131, '2026-07-01T09:41:47.131Z'),
(7, '39740973842d94ed288037843caaf79d4568aac588989c28291865ad90416296', 'session', 'u_1782898429231_1586eee8', 1783504141389, '2026-07-01T09:49:01.389Z'),
(11, '35fd605931afef2912b131358b78352c34a0aafc653cb9dfff577b6b43197143', 'session', 'u_1782898429231_1586eee8', 1784014319540, '2026-07-07T07:31:59.540Z'),
(12, '45a428a0b18ebf82039351861577c6fa1d4e3c908a350e0b10bb81a92e73717c', 'session', 'u_1782898429231_1586eee8', 1784016335071, '2026-07-07T08:05:35.071Z'),
(13, '5da0162b12b441b6e830e1fadea34f753d815f2b8e94ae056119eb21ca2e72ab', 'session', 'u_1782898429231_1586eee8', 1784016346577, '2026-07-07T08:05:46.577Z'),
(14, '003618246f000b3d5b7b743e1a3f1f54b296bfce97b3867f2e8a9cab1da616fa', 'session', 'u_1782898429231_1586eee8', 1784016361826, '2026-07-07T08:06:01.826Z'),
(15, '46f300d9e120a89765499fc767f45e1ead442eafc3c1751dc06e07543d7e2aea', 'session', 'u_1782898429231_1586eee8', 1784016378167, '2026-07-07T08:06:18.167Z'),
(16, 'ba3057d5e691ec7c04f893de48df4f74360f7f6f2b29d55881664305ba843618', 'session', 'u_1782898429231_1586eee8', 1784016478858, '2026-07-07T08:07:58.858Z'),
(17, '374b798604f0c08f7b3eecb6e4c00384b5d22c9c36197263c2ae7c818eba19c3', 'session', 'u_1782898429231_1586eee8', 1784016488448, '2026-07-07T08:08:08.448Z'),
(18, 'd4590db8db9a9ae1200272446355fa4dcbc133f635c3b5f39a5be37b2997701c', 'session', 'u_1782898429231_1586eee8', 1784016489740, '2026-07-07T08:08:09.740Z'),
(19, 'af1f15e9bc25618922f76c01fc15b0d2ff238f7dc745d5b59e894256af3a1da8', 'session', 'u_1782898429231_1586eee8', 1784016490974, '2026-07-07T08:08:10.974Z'),
(20, '2fc96c8780888d9c11ab0fa8c464cb188d9b068ecba015c0d657881ee8a1237a', 'session', 'u_1782898429231_1586eee8', 1784016491812, '2026-07-07T08:08:11.812Z'),
(21, '83d2920202e69e26b41a9c51d225cc8cba32a63488f1a94b230c8cfd8865eefe', 'session', 'u_1782898429231_1586eee8', 1784016492607, '2026-07-07T08:08:12.607Z'),
(22, '6933bd270025586aeeb232c5ef9194cef2d94aad8043b56f9cbc03b6a1ce98c7', 'session', 'u_1782898429231_1586eee8', 1784016493352, '2026-07-07T08:08:13.352Z'),
(23, 'e8c07b9f491b3f28a0a625293854c085c10383cd64fcf0a5085cc47014fc9394', 'session', 'u_1782898429231_1586eee8', 1784016494123, '2026-07-07T08:08:14.123Z'),
(25, '9f9ec3d3e63e11d49d55fb43301b33f69b4973c59977c62fee5f9eda0b9b798f', 'session', 'u_1782898429231_1586eee8', 1784016644076, '2026-07-07T08:10:44.076Z'),
(26, '63a494de567bfb3bbb04e91d3e61143bc6546a93c809f7dc1e9c4b35b22f9e75', 'session', 'u_1782898429231_1586eee8', 1784016658198, '2026-07-07T08:10:58.198Z'),
(27, '15dba34bddb330c4a9bb985311572f4b314006f7aed84e812ba9fa657ea42452', 'session', 'u_1782898429231_1586eee8', 1784016699972, '2026-07-07T08:11:39.972Z'),
(28, '40c6794fe9a134868e82b2572aac3bb3f35c7d53e77cd99106f5c5fa59b74d08', 'session', 'u_1782898429231_1586eee8', 1784017047540, '2026-07-07T08:17:27.540Z'),
(29, '6f99a1a8938d65fc1b59525d0fbbb61622f1518696aec5a772b01e0f311c72ed', 'session', 'u_1782898429231_1586eee8', 1784017057751, '2026-07-07T08:17:37.751Z'),
(30, 'eb7451c9fa885b12a5ba1cc3c8d3d7e313bacd0cba20af2d6b57d57c97129ef9', 'session', 'u_admin_1782897984459_aac73701', 1784018194070, '2026-07-07T08:36:34.070Z'),
(32, 'b4738b72a67cdb59f16e2a8076589c4bb612c5a877069f1f1d83196022e7017a', 'session', 'u_1782898429231_1586eee8', 1784019575153, '2026-07-07T08:59:35.153Z'),
(33, 'ce27a63be6c279749ccb8042b48e3fca7b981f4fd6e99224128c907644dff593', 'session', 'u_1783414887587_d14539d0', 1784019730290, '2026-07-07T09:02:10.290Z'),
(34, '80a145237fade6da6a9aefa2edd910a007daf4eb3f5befd2b2f875d185260c53', 'session', 'u_1783414887587_d14539d0', 1784019900051, '2026-07-07T09:05:00.051Z'),
(35, '152b96d63ac6902011788124035f0d9a49fd3bd9ed8ed7a7fa6c303b99997b43', 'session', 'u_1783415194765_266d7766', 1784019994957, '2026-07-07T09:06:34.957Z'),
(36, '9f672dbc0bfec92515755b8916d0bc88200366573903b57509f40d285702af2a', 'session', 'u_1783414887587_d14539d0', 1784020207411, '2026-07-07T09:10:07.411Z'),
(37, '023bf7f8f7ab734068e2ded8e676ccaae41c5d0e88b8b8a2ff104bb479e37415', 'session', 'u_1783414887587_d14539d0', 1784020216668, '2026-07-07T09:10:16.668Z'),
(38, 'd6fff6299746d7e7fc469fb744d2499e8d792d8cd9141905e66f448aca601f8b', 'session', 'u_1783414887587_d14539d0', 1784020650540, '2026-07-07T09:17:30.540Z'),
(39, '0c0396ba4b643079a949f7673caf86de0c5c91fbf99391dca7d0c056dc59a043', 'session', 'u_1783414887587_d14539d0', 1784020757495, '2026-07-07T09:19:17.495Z'),
(40, 'a252b1a1cbff8a8e53f92ebd55eb03e7d136cbe16b41a352406bea0e95464f6b', 'session', 'u_1782898429231_1586eee8', 1784020780081, '2026-07-07T09:19:40.081Z'),
(41, '95925516f3bef13b73aa08dc9176d0f14f435d941ee7b8b9097c692cbe04a997', 'session', 'u_1782898429231_1586eee8', 1784082603069, '2026-07-08T02:30:03.069Z'),
(42, 'b4c12036ee8bd67a5a4e5868d3ef67ebd999cbbee12429d483d961ddf50ca5c8', 'session', 'u_admin_1782897984459_aac73701', 1784084170448, '2026-07-08T02:56:10.448Z');

-- --------------------------------------------------------

--
-- Cấu trúc bảng cho bảng `users`
--

CREATE TABLE `users` (
  `id` varchar(64) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password_hash` varchar(512) NOT NULL,
  `role` varchar(20) NOT NULL DEFAULT 'user',
  `points` int(11) NOT NULL DEFAULT 0,
  `package_id` varchar(64) DEFAULT NULL,
  `is_active` tinyint(4) NOT NULL DEFAULT 1,
  `created_at` varchar(64) NOT NULL,
  `package_expires_at` varchar(64) DEFAULT NULL,
  `full_name` varchar(255) DEFAULT NULL,
  `phone` varchar(32) DEFAULT NULL,
  `accepted_terms_at` varchar(64) DEFAULT NULL,
  `accepted_terms_version` varchar(32) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Đang đổ dữ liệu cho bảng `users`
--

INSERT INTO `users` (`id`, `email`, `password_hash`, `role`, `points`, `package_id`, `is_active`, `created_at`, `package_expires_at`, `full_name`, `phone`, `accepted_terms_at`, `accepted_terms_version`) VALUES
('u_1782898429231_1586eee8', 'xthg04@gmail.com', 'cfc33d541fe984d970f82f4a0ff9ce95:64d06f01ccfa77d8a3e3ff8e599262e34968526faa1a4fd82023726c03e4d6d959c1056b89bdb691e07dcc5413ece4be53bb0e99e0990bd008b4b95f169a437a', 'user', 32261, 'pkg_starter', 1, '2026-07-01T09:33:49.318Z', '2026-08-06T07:42:01.969Z', 'Thang ne', '0321654789', '2026-07-07T08:06:15.297Z', 'v1'),
('u_1783414887587_d14539d0', 'xthg041@gmail.com', '866b429d12d54131b7febde5891ae366:ccef4586ee2347e4b062e386f3144d7ab357284e64452c681476c2bbbdb770f4ef196d6493ed971bcb2f59b5ecbe500552acfea2d949174479cfcf539c751a7e', 'user', 30000, 'pkg_starter', 1, '2026-07-07T09:01:27.678Z', '2026-08-06T09:01:27.587Z', 'thang', '0789456123', NULL, NULL),
('u_1783415194765_266d7766', 'tahng@gmail.com', 'ab6eda51875cde9678f54e7b460044e4:4a1a2cb2e995a08d74a44ede6923ab86e3ebd083f454c46747d845608d1a038066bfee75b130a0b0509f6588c4ed16dd9ea50417bddd079b76f768afc3d2f8ad', 'user', 0, NULL, 1, '2026-07-07T09:06:34.849Z', NULL, 'thang', '0123456789', NULL, NULL),
('u_admin_1782897984459_aac73701', 'admin@timdiemban.local', '41175ae27457e7ac96a33227ace2754a:6fa77132ae50f7ad1a8b81ad648ea45365fc6de1454c5ee4b96c303e1765206d0492d510bf4a5318fea9095f513a19a09fbf46f25f17eb687dd4b34464617bf1', 'admin', 0, NULL, 1, '2026-07-01T09:26:24.536Z', NULL, NULL, NULL, NULL, NULL);

--
-- Chỉ mục cho các bảng đã đổ
--

--
-- Chỉ mục cho bảng `packages`
--
ALTER TABLE `packages`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_points` (`points`);

--
-- Chỉ mục cho bảng `package_orders`
--
ALTER TABLE `package_orders`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_status` (`status`),
  ADD KEY `idx_user_id` (`user_id`),
  ADD KEY `fk_po_pkg` (`package_id`),
  ADD KEY `fk_po_admin` (`admin_id`);

--
-- Chỉ mục cho bảng `settings`
--
ALTER TABLE `settings`
  ADD PRIMARY KEY (`key`);

--
-- Chỉ mục cho bảng `tokens`
--
ALTER TABLE `tokens`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_token` (`token`),
  ADD KEY `idx_user` (`user_id`);

--
-- Chỉ mục cho bảng `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_email` (`email`);

--
-- AUTO_INCREMENT cho các bảng đã đổ
--

--
-- AUTO_INCREMENT cho bảng `tokens`
--
ALTER TABLE `tokens`
  MODIFY `id` bigint(20) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=43;

--
-- Các ràng buộc cho các bảng đã đổ
--

--
-- Các ràng buộc cho bảng `package_orders`
--
ALTER TABLE `package_orders`
  ADD CONSTRAINT `fk_po_admin` FOREIGN KEY (`admin_id`) REFERENCES `users` (`id`),
  ADD CONSTRAINT `fk_po_pkg` FOREIGN KEY (`package_id`) REFERENCES `packages` (`id`),
  ADD CONSTRAINT `fk_po_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Các ràng buộc cho bảng `tokens`
--
ALTER TABLE `tokens`
  ADD CONSTRAINT `fk_tokens_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
