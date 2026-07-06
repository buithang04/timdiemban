require("fs").readFileSync(require("path").join(__dirname, "..", ".env"), "utf8")
  .split(/\r?\n/)
  .forEach((l) => {
    const t = l.trim();
    if (!t || t.startsWith("#")) return;
    const i = t.indexOf("=");
    if (i > 0) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  });

const mysql = require("mysql2/promise");
const { generateVietQrV2 } = require("../vietqr");

async function main() {
  const p = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "localhost",
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "timdiemban"
  });

  const [rows] = await p.execute(
    "SELECT `key`, value FROM settings WHERE `key` LIKE 'vietqr%' ORDER BY `key`"
  );
  console.log("=== Settings in DB ===");
  const cfg = {};
  for (const r of rows) {
    cfg[r.key] = r.value || "";
    if (r.key.includes("api_key")) {
      console.log(r.key + ":", r.value ? `[set, len=${r.value.length}]` : "(empty)");
    } else {
      console.log(r.key + ":", r.value || "(empty)");
    }
  }

  const clientId = cfg.vietqr_client_id;
  const apiKey = cfg.vietqr_api_key;
  const accountNo = cfg.vietqr_account_no;
  const accountName = cfg.vietqr_account_name;
  const acqId = cfg.vietqr_acq_id || cfg.vietqr_bank_id;

  console.log("\n=== Test API v2 ===");
  if (!clientId || !apiKey) {
    console.log("MISSING client_id or api_key in DB");
    await p.end();
    return;
  }

  try {
    const result = await generateVietQrV2({
      clientId,
      apiKey,
      accountNo: accountNo || "8325896836",
      accountName: accountName || "TEST USER",
      acqId: Number(acqId) || 970422,
      amount: 99000,
      addInfo: "TEST ORDER 123",
      template: "compact2"
    });
    console.log("OK method:", result.method);
    console.log("qrUrl starts with:", result.qrUrl?.slice(0, 40));
  } catch (err) {
    console.log("FAIL:", err.message);
  }

  await p.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
