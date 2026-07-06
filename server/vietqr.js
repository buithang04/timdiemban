/**
 * VietQR API v2 — POST https://api.vietqr.io/v2/generate
 * Docs: https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/api-tao-ma-qr
 */

/** Mã BIN 6 số — dùng khi admin nhập mã ngắn (MB, VCB…) thay vì acqId */
const BANK_BIN = {
  MB: 970422,
  MBB: 970422,
  MBBANK: 970422,
  VCB: 970436,
  TCB: 970407,
  BIDV: 970418,
  ACB: 970416,
  VPB: 970432,
  STB: 970403,
  HDB: 970437,
  VIB: 970441,
  SHB: 970443,
  OCB: 970448,
  MSB: 970426,
  ICB: 970415,
  VIETINBANK: 970415,
  VIETCOMBANK: 970436,
  TECHCOMBANK: 970407
};

function resolveAcqId(bankId, acqIdSetting) {
  const raw = String(acqIdSetting || "").trim();
  if (/^\d{6}$/.test(raw)) return Number(raw);
  const key = String(bankId || "").trim().toUpperCase();
  if (BANK_BIN[key]) return BANK_BIN[key];
  if (/^\d{6}$/.test(key)) return Number(key);
  return null;
}

/** Nội dung CK: tối đa 25 ký tự, không dấu, không ký tự đặc biệt (theo VietQR v2) */
function sanitizeAddInfo(text) {
  const s = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 25);
  return s || "Thanh toan goi diem";
}

/** Tên TK: không dấu, in hoa */
function sanitizeAccountName(name) {
  return String(name || "TIM DIEM BAN")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .slice(0, 50);
}

/**
 * Gọi VietQR API v2 → trả qrDataURL (data:image/png;base64,...)
 */
async function generateVietQrV2({
  clientId,
  apiKey,
  accountNo,
  accountName,
  acqId,
  amount,
  addInfo,
  template = "compact2"
}) {
  if (!clientId || !apiKey) {
    throw new Error("Thiếu Client ID hoặc API Key VietQR");
  }
  if (!accountNo || !acqId) {
    throw new Error("Thiếu số tài khoản hoặc mã BIN ngân hàng (acqId)");
  }

  const res = await fetch("https://api.vietqr.io/v2/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-id": clientId,
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      accountNo: String(accountNo).trim(),
      accountName: sanitizeAccountName(accountName),
      acqId: Number(acqId),
      amount: Number(amount) || 0,
      addInfo: sanitizeAddInfo(addInfo),
      template
    })
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(json.desc || json.message || `VietQR HTTP ${res.status}`);
  }

  if (json.code && json.code !== "00") {
    throw new Error(json.desc || "VietQR từ chối tạo mã");
  }

  const data = json.data || json;
  if (!data.qrDataURL) {
    throw new Error("VietQR không trả về qrDataURL");
  }

  return {
    qrUrl: data.qrDataURL,
    qrCode: data.qrCode || "",
    method: "api-v2"
  };
}

/** Quick Link (không cần API key) — fallback */
function buildQuickLinkUrl({ bankId, accountNo, accountName, amount, addInfo }) {
  if (!bankId || !accountNo) return null;
  const note = encodeURIComponent(sanitizeAddInfo(addInfo));
  const aName = encodeURIComponent(sanitizeAccountName(accountName));
  return {
    qrUrl: `https://img.vietqr.io/image/${bankId}-${accountNo}-compact2.png?amount=${Number(amount) || 0}&addInfo=${note}&accountName=${aName}`,
    qrCode: "",
    method: "quick-link"
  };
}

module.exports = {
  BANK_BIN,
  resolveAcqId,
  sanitizeAddInfo,
  sanitizeAccountName,
  generateVietQrV2,
  buildQuickLinkUrl
};
