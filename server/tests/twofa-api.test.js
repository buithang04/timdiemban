const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { authenticator } = require("otplib");

const rootDir = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), "utf8");

test("/api/2fa dùng authenticator API tương thích Node 18 trên production", () => {
  const source = read("server", "server.js");
  const packageJson = JSON.parse(read("server", "package.json"));

  assert.equal(packageJson.dependencies.otplib, "12.0.1");
  assert.match(source, /const \{ authenticator \} = require\("otplib"\)/);
  assert.match(source, /app\.post\("\/api\/2fa"/);
  assert.match(source, /authenticator\.generate\(normalizedSecret\)/);
  assert.doesNotMatch(source, /@otplib\/plugin-base32-scure/);
});

test("otplib tạo được mã 6 số từ Base32 secret 16 ký tự thường gặp", () => {
  const code = authenticator.generate("JBSWY3DPEHPK3PXP");

  assert.match(code, /^\d{6}$/);
});

test("/api/2fa vẫn chặn secret không phải Base32 trước khi gọi thư viện", () => {
  const source = read("server", "server.js");

  assert.match(source, /\^\[A-Z2-7\]\+=\*\$/);
  assert.match(source, /Invalid 2FA secret \(must be Base32: A-Z, 2-7\)/);
});
