/**
 * CMS media library — files under web/media (images + videos).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MEDIA_DIR = path.join(__dirname, "..", "web", "media");
const PUBLIC_PREFIX = "/media";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".avif"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".ogg", ".mov"]);

function ensureMediaDir() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const keep = path.join(MEDIA_DIR, ".gitkeep");
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, "");
}

function extOf(name) {
  return path.extname(String(name || "")).toLowerCase();
}

function mediaKind(filename) {
  const ext = extOf(filename);
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return "file";
}

function safeFilename(original) {
  const base = path
    .basename(String(original || "file"))
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  const ext = extOf(base) || extOf(original) || "";
  const stem = (ext ? base.slice(0, -ext.length) : base) || "file";
  const id = crypto.randomBytes(4).toString("hex");
  return `${Date.now()}-${id}-${stem}${ext}`.toLowerCase();
}

function isAllowedUpload(filename, mime) {
  const ext = extOf(filename);
  const kind = mediaKind(filename);
  const m = String(mime || "").toLowerCase();
  if (kind === "image") {
    return !m || m === "application/octet-stream" || /^image\//i.test(m) || m === "image/svg+xml";
  }
  if (kind === "video") {
    return !m || m === "application/octet-stream" || /^video\//i.test(m);
  }
  return false;
}

function listMedia({ type = "all", limit = 200 } = {}) {
  ensureMediaDir();
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const files = fs
    .readdirSync(MEDIA_DIR)
    .filter((f) => f !== ".gitkeep" && !f.startsWith("."))
    .map((name) => {
      const full = path.join(MEDIA_DIR, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        return null;
      }
      if (!stat.isFile()) return null;
      const kind = mediaKind(name);
      return {
        name,
        url: `${PUBLIC_PREFIX}/${name}`,
        kind,
        size: stat.size,
        updated_at: stat.mtime.toISOString()
      };
    })
    .filter(Boolean)
    .filter((m) => (type === "image" || type === "video" ? m.kind === type : true))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, lim);
  return files;
}

function deleteMedia(name) {
  const safe = path.basename(String(name || ""));
  if (!safe || safe === ".gitkeep" || safe.startsWith(".")) {
    throw new Error("Tên file không hợp lệ");
  }
  const full = path.join(MEDIA_DIR, safe);
  if (!full.startsWith(MEDIA_DIR)) throw new Error("Đường dẫn không hợp lệ");
  if (!fs.existsSync(full)) throw new Error("Không tìm thấy file");
  fs.unlinkSync(full);
  return true;
}

function assertSafeName(name) {
  const safe = path.basename(String(name || ""));
  if (!safe || safe === ".gitkeep" || safe.startsWith(".") || safe.includes("..")) {
    throw new Error("Tên file không hợp lệ");
  }
  const full = path.join(MEDIA_DIR, safe);
  if (!full.startsWith(MEDIA_DIR)) throw new Error("Đường dẫn không hợp lệ");
  return { safe, full };
}

function getMediaItem(name) {
  const { safe, full } = assertSafeName(name);
  if (!fs.existsSync(full)) throw new Error("Không tìm thấy file");
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error("Không tìm thấy file");
  return {
    name: safe,
    url: `${PUBLIC_PREFIX}/${safe}`,
    kind: mediaKind(safe),
    size: stat.size,
    updated_at: stat.mtime.toISOString()
  };
}

/** Đổi tên file trong /media (giữ phần mở rộng nếu newName không có). */
function renameMedia(oldName, newNameRaw) {
  ensureMediaDir();
  const { safe: from, full: fromPath } = assertSafeName(oldName);
  if (!fs.existsSync(fromPath)) throw new Error("Không tìm thấy file");

  let next = path.basename(String(newNameRaw || "").trim());
  next = next
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
  if (!next) throw new Error("Tên mới không hợp lệ");
  if (!extOf(next)) next += extOf(from);
  if (!IMAGE_EXT.has(extOf(next)) && !VIDEO_EXT.has(extOf(next))) {
    throw new Error("Phần mở rộng không được hỗ trợ");
  }
  if (next === from) return getMediaItem(from);

  const toPath = path.join(MEDIA_DIR, next);
  if (!toPath.startsWith(MEDIA_DIR)) throw new Error("Đường dẫn không hợp lệ");
  if (fs.existsSync(toPath)) throw new Error("Tên file đã tồn tại");
  fs.renameSync(fromPath, toPath);
  return getMediaItem(next);
}

/** Ghi đè nội dung file (giữ tên cũ). */
function replaceMediaFile(name, sourcePath) {
  ensureMediaDir();
  const { safe, full } = assertSafeName(name);
  if (!fs.existsSync(full)) throw new Error("Không tìm thấy file");
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error("Thiếu file thay thế");
  const srcKind = mediaKind(sourcePath);
  const destKind = mediaKind(safe);
  if (srcKind !== destKind) {
    throw new Error("Loại file thay thế phải cùng loại (ảnh/video)");
  }
  fs.copyFileSync(sourcePath, full);
  try {
    fs.unlinkSync(sourcePath);
  } catch {
    /* temp already moved */
  }
  // touch mtime
  const now = new Date();
  fs.utimesSync(full, now, now);
  return getMediaItem(safe);
}

module.exports = {
  MEDIA_DIR,
  PUBLIC_PREFIX,
  ensureMediaDir,
  safeFilename,
  isAllowedUpload,
  mediaKind,
  listMedia,
  deleteMedia,
  getMediaItem,
  renameMedia,
  replaceMediaFile
};
