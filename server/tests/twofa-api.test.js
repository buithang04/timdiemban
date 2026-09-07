const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createGuardrails, generate } = require("otplib");

const rootDir = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), "utf8");

test("/api/2fa dùng API otplib v13 đúng entrypoint và hỗ trợ secret Google Authenticator phổ biến", () => {
  const source = read("server", "server.js");

  assert.match(source, /const \{ createGuardrails, generate: generateTotp \} = require\("otplib"\)/);
  assert.match(source, /MIN_SECRET_BYTES:\s*10/);
  assert.match(source, /app\.post\("\/api\/2fa"/);
  assert.match(source, /await generateTotp\(\{\s*secret:\s*normalizedSecret,\s*guardrails:\s*TWO_FACTOR_GUARDRAILS\s*\}\)/s);
  assert.doesNotMatch(source, /authenticator\.generate/);
});

test("otplib tạo được mã 6 số từ Base32 secret 16 ký tự thường gặp", async () => {
  const code = await generate({
    secret: "JBSWY3DPEHPK3PXP",
    guardrails: createGuardrails({ MIN_SECRET_BYTES: 10 })
  });

  assert.match(code, /^\d{6}$/);
});

test("otplib vẫn từ chối Base32 secret quá ngắn", async () => {
  await assert.rejects(
    () =>
      generate({
        secret: "AAAA",
        guardrails: createGuardrails({ MIN_SECRET_BYTES: 10 })
      }),
    /Secret must be at least/
  );
});
