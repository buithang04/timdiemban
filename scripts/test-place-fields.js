/**
 * Test siêu kỹ parse địa chỉ / SĐT / enrich + tích hợp grid.
 * Chạy: node scripts/test-place-fields.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PF = require(path.join(__dirname, "..", "extension", "place-fields.js"));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "extension", "grid.js"), "utf8"), {
  filename: "grid.js"
});

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push({ name, message: err.message });
    console.log("  ✗", name, "→", err.message);
  }
}

function eq(a, b, msg) {
  assert.strictEqual(a, b, msg || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function ok(c, msg) {
  assert.ok(c, msg || "expected truthy");
}
function neq(a, b, msg) {
  assert.notStrictEqual(a, b, msg);
}

function mustReject(raw, why) {
  test(`REJECT ${why}: ${JSON.stringify(String(raw).slice(0, 60))}`, () => {
    eq(PF.isValidAddressField(raw), false);
    const cleaned = PF.sanitizeAddressField(raw);
    ok(!cleaned || !PF.isValidAddressField(cleaned), `cleaned still valid: ${cleaned}`);
  });
}

function mustKeep(raw, mustInclude) {
  test(`KEEP ${JSON.stringify(String(raw).slice(0, 50))}`, () => {
    const cleaned = PF.sanitizeAddressField(raw);
    ok(cleaned.length >= 6, `empty: ${cleaned}`);
    ok(PF.isValidAddressField(cleaned), `invalid: ${cleaned}`);
    if (mustInclude) {
      const parts = Array.isArray(mustInclude) ? mustInclude : [mustInclude];
      for (const p of parts) ok(cleaned.includes(p), `missing "${p}" in ${cleaned}`);
    }
  });
}

console.log("\n═══ A. Case production đã báo ═══");
mustReject("+84 225 3668 881 Trang web Đường đi", "prod screenshot");
mustReject("+84 225 3668 881 trang web đường đi", "lowercase");
mustReject("＋84 225 3668 881 Trang web Đường đi", "fullwidth plus soft"); // may still fail extract — check below

test("recover prod → phone + empty addr", () => {
  const p = PF.recoverContactFieldsFromAddress({
    address: "+84 225 3668 881 Trang web Đường đi",
    phone: ""
  });
  eq(p.address, "");
  ok(PF.normalizePhone(p.phone).length >= 10, p.phone);
});

test("sanitizePlace(grid) prod case", () => {
  const p = sanitizePlace(
    {
      name: "Phòng Khám Đa Khoa Medical Hải Phòng",
      address: "+84 225 3668 881 Trang web Đường đi",
      phone: "",
      website: "",
      rating: "5.0",
      reviews: "479",
      lat: 20.82461,
      lng: 106.62451
    },
    20.82,
    106.62,
    5
  );
  ok(p, "place dropped");
  eq(p.address, "");
  ok(PF.normalizePhone(p.phone).length >= 9, p.phone);
  const en = getEnrichProfile(p);
  ok(en?.needAddress, JSON.stringify(en));
});

console.log("\n═══ B. Rác UI Maps (VI + EN) ═══");
[
  "Trang web",
  "Website",
  "Đường đi",
  "Directions",
  "Trang web Đường đi",
  "Website Directions",
  "Tổng quan",
  "Overview",
  "Bài đánh giá",
  "Reviews",
  "Giới thiệu",
  "About",
  "Gần đó",
  "Nearby",
  "Chia sẻ",
  "Share",
  "Gửi tới điện thoại",
  "Send to your phone",
  "Tổng quan Bài đánh giá Giới thiệu Đường đi",
  "Overview · Reviews · About · Directions",
  "Gửi tới điện thoại Chia sẻ Tổng quan",
  "Xem ảnh",
  "See photos",
  "Lưu",
  "Save",
  "Đặt chỗ",
  "Order",
  "Menu",
  "Thực đơn",
  "Sao chép địa chỉ",
  "Copy address",
  "Sao chép số điện thoại",
  "Copy phone number",
  "Đường liên kết đã truy cập",
  "Đường liên kết đã truy cập ·",
  "Visited link",
  "Mua sắm tại cửa hàng",
  "Shop in store",
  "In-store shopping"
].forEach((g) => mustReject(g, "ui"));

console.log("\n═══ C. Rác rating / giờ / category ═══");
[
  "5.0 (479)",
  "4,8 (1.234)",
  "4.5 (12)",
  "Đang mở cửa",
  "Đóng cửa · 22:00",
  "Mở cửa lúc 08:00",
  "Open now",
  "Closes soon",
  "Cửa hàng tiện lợi",
  "Convenience store",
  "Siêu thị",
  "Nhà hàng",
  "Cafe",
  "Pharmacy",
  "4.2 / Cửa hàng",
  "3,9 / Tạp hóa"
].forEach((g) => mustReject(g, "meta"));

console.log("\n═══ D. Chỉ SĐT / SĐT+UI ═══");
[
  "+84 225 3668 881",
  "+842253668881",
  "84 225 3668 881",
  "0225 366 8881",
  "02253668881",
  "0912 345 678",
  "0912345678",
  "0123 456 789",
  "0 225 3668 881",
  "+84 24 1234 5678 Trang web",
  "0912 345 678 Đường đi",
  "Call +84 912 345 678",
  "Gọi 0912 345 678",
  "(+84) 225 3668 881 Trang web Đường đi"
].forEach((g) => mustReject(g, "phone"));

console.log("\n═══ E. Địa chỉ VN thật phải giữ ═══");
const good = [
  ["123 Đường Lạch Tray, Ngô Quyền, Hải Phòng, Việt Nam", ["Lạch Tray", "Hải Phòng"]],
  ["442 Đ. Trường Chinh, Thanh Xuân, Hà Nội", ["Trường Chinh"]],
  ["Số 15 phố Huế, Hai Bà Trưng, Hà Nội", ["Huế"]],
  ["Ngõ 12 Nguyễn Trãi, Thanh Xuân, Hà Nội", ["Nguyễn Trãi"]],
  ["Ngách 5/12 Đội Cấn, Ba Đình, Hà Nội", ["Đội Cấn"]],
  ["Hẻm 123 Lê Lợi, Quận 1, TP. Hồ Chí Minh", ["Lê Lợi"]],
  ["Lô A1, Khu CN Đình Trám, Việt Yên, Bắc Giang", ["Đình Trám"]],
  ["Thôn Đông, Xã Nam Sơn, An Dương, Hải Phòng", ["Nam Sơn"]],
  ["Ấp 3, Xã Tân Phú, Châu Thành, Đồng Tháp", ["Tân Phú"]],
  ["Tổ 5, P. Thành Công, TP. Thái Nguyên", ["Thành Công"]],
  ["120 Đường 3/2, Quận 10, TP. Hồ Chí Minh", ["3/2"]],
  ["25 Nguyễn Văn Cừ, Ninh Kiều, Cần Thơ", ["Nguyễn Văn Cừ"]],
  ["08 Trần Phú, Lộc Thọ, Nha Trang, Khánh Hòa", ["Trần Phú"]],
  ["SN 42, Đường Hoàng Quốc Việt, Cầu Giấy, Hà Nội", ["Hoàng Quốc Việt"]],
  ["Khu phố 2, Phường An Bình, Dĩ An, Bình Dương", ["An Bình"]],
  ["Block A, Chung cư Homyland 2, Quận 2, TP.HCM", ["Homyland"]],
  ["15 Street 5, Binh Thanh, Ho Chi Minh City, Vietnam", ["Binh Thanh"]],
  ["123 Nguyen Trai Street, District 5, Ho Chi Minh", ["Nguyen Trai"]]
];
for (const [a, parts] of good) mustKeep(a, parts);

console.log("\n═══ F. Địa chỉ thật dính SĐT/UI — phải giữ phần địa chỉ ═══");
test("addr + phone cuối", () => {
  const c = PF.sanitizeAddressField("123 Đường Lạch Tray, Hải Phòng +84 225 3668 881");
  ok(c.includes("Lạch Tray"), c);
  ok(!/\+84|0225/.test(c), c);
  ok(PF.isValidAddressField(c));
});
test("phone đầu + addr", () => {
  const c = PF.sanitizeAddressField("+84 225 3668 881 123 Đường Lạch Tray, Hải Phòng, Việt Nam");
  ok(c.includes("Lạch Tray"), c);
  ok(PF.isValidAddressField(c));
});
test("addr + Trang web Đường đi", () => {
  const c = PF.sanitizeAddressField("15 phố Huế, Hà Nội Trang web Đường đi");
  ok(c.includes("Huế") || c.includes("Hà Nội"), c);
  ok(!/trang\s*web|đường\s*đi/i.test(c), c);
});
test("addr · phone · website labels", () => {
  const c = PF.sanitizeAddressField("442 Đ. Trường Chinh, Hà Nội · Trang web · Đường đi");
  ok(c.includes("Trường Chinh"), c);
});
test("recover: phone từ addr, giữ addr sạch", () => {
  const p = PF.recoverContactFieldsFromAddress({
    address: "15 phố Huế, Hà Nội +84912345678",
    phone: ""
  });
  ok(p.address.includes("Huế"), p.address);
  eq(PF.normalizePhone(p.phone), "0912345678");
});
test("recover không đè phone sẵn có", () => {
  const p = PF.recoverContactFieldsFromAddress({
    address: "+84 225 3668 881 xxx",
    phone: "0912 345 678"
  });
  eq(PF.normalizePhone(p.phone), "0912345678");
});

console.log("\n═══ G. hasStreetKeyword / Đường đi ═══");
test("Đường đi false", () => eq(PF.hasStreetKeyword("Đường đi"), false));
test("Đường Lạch Tray true", () => ok(PF.hasStreetKeyword("Đường Lạch Tray")));
test("đ. Trường Chinh true", () => ok(PF.hasStreetKeyword("đ. Trường Chinh")));
test("phố Huế true", () => ok(PF.hasStreetKeyword("phố Huế")));
test("only Directions false", () => eq(PF.hasStreetKeyword("Directions"), false));

console.log("\n═══ H. pickBetter* ═══");
test("pickBetterAddress chọn thật", () => {
  const b = PF.pickBetterAddress(
    "+84 225 3668 881 Trang web Đường đi",
    "123 Đường Lạch Tray, Hải Phòng"
  );
  ok(b.includes("Lạch Tray"), b);
});
test("pickBetterAddress không chọn rác dài", () => {
  const b = PF.pickBetterAddress(
    "Tổng quan Bài đánh giá Giới thiệu Đường đi Gần đó Chia sẻ",
    "15 phố Huế, Hà Nội"
  );
  ok(b.includes("Huế") || b.includes("Hà Nội"), b);
});
test("pickBetterAddress 2 địa chỉ → dài/đầy đủ hơn", () => {
  const b = PF.pickBetterAddress(
    "442 Đ. Trường Chinh",
    "442 Đ. Trường Chinh, Thanh Xuân, Hà Nội, Việt Nam"
  );
  ok(b.includes("Thanh Xuân") || b.includes("Việt Nam"), b);
});
test("pickBetterPhone ưu tiên đủ số", () => {
  eq(PF.normalizePhone(PF.pickBetterPhone("123", "0912345678")), "0912345678");
  eq(PF.normalizePhone(PF.pickBetterPhone("0912345678", "")), "0912345678");
});

console.log("\n═══ I. format / normalize phone ═══");
test("+84 mobile → 0", () => {
  const f = PF.formatPhoneVN("+84 912 345 678");
  eq(PF.normalizePhone(f), "0912345678");
});
test("+84 landline 0225", () => {
  const d = PF.normalizePhone(PF.formatPhoneVN("+84 225 3668 881"));
  ok(d.startsWith("0225") || d.startsWith("225"), d);
  ok(d.length >= 10, d);
});
test("đã 0xxx giữ nguyên digits", () => {
  eq(PF.normalizePhone(PF.formatPhoneVN("0912 345 678")), "0912345678");
});
test("quá ngắn không format ảo", () => {
  eq(PF.formatPhoneVN("12345"), "12345");
});
test("extract nhiều số → dài nhất", () => {
  const ph = PF.extractPhoneFromText("gọi 090123456 hoặc +84 912 345 678");
  eq(PF.normalizePhone(PF.formatPhoneVN(ph)), "0912345678");
});

console.log("\n═══ J. Enrich profile ═══");
test("đủ → null", () => {
  eq(
    PF.getEnrichProfile({
      address: "123 Đường Lạch Tray, Hải Phòng, Việt Nam",
      phone: "02253668881",
      rating: "5",
      reviews: "10"
    }),
    null
  );
});
test("thiếu phone", () => {
  const e = PF.getEnrichProfile({
    address: "123 Đường Lạch Tray, Hải Phòng, Việt Nam",
    phone: "",
    rating: "5",
    reviews: "10"
  });
  ok(e?.needPhone);
  eq(e.needAddress, false);
});
test("rác addr → needAddress dù có rating", () => {
  const e = PF.getEnrichProfile({
    address: "+84 225 3668 881 Trang web Đường đi",
    phone: "02253668881",
    rating: "5.0",
    reviews: "479"
  });
  ok(e?.needAddress, JSON.stringify(e));
});
test("rác addr + empty phone → recover phone, vẫn needAddress", () => {
  const e = PF.getEnrichProfile({
    address: "+84 225 3668 881 Trang web Đường đi",
    phone: "",
    rating: "5.0",
    reviews: "479"
  });
  ok(e?.needAddress);
  eq(e.needPhone, false);
});
test("placeNeedsEnrich true/false", () => {
  ok(PF.placeNeedsEnrich({ address: "Đường đi", phone: "", rating: "", reviews: "" }));
  ok(
    !PF.placeNeedsEnrich({
      address: "123 Đường Lạch Tray, Hải Phòng, Việt Nam",
      phone: "0912345678",
      rating: "4.5",
      reviews: "9"
    })
  );
});

console.log("\n═══ K. Edge / tấn / null / URL / tọa độ ═══");
[
  "",
  null,
  undefined,
  "   ",
  "abc",
  "123",
  "https://example.com",
  "http://shop.vn/page",
  "www.facebook.com/page",
  "20.82461, 106.62451",
  "@20.82461,106.62451,17z",
  "•••••",
  "----",
  ",,,",
  "· · ·"
].forEach((g, i) => mustReject(g, `edge${i}`));

test("null recover an toàn", () => eq(PF.recoverContactFieldsFromAddress(null), null));
test("object rỗng address", () => {
  const p = PF.recoverContactFieldsFromAddress({ address: "", phone: "" });
  eq(p.address, "");
});

console.log("\n═══ L. Không phá địa chỉ có từ gần UI ═══");
mustKeep("12 Đường Website, Quận 1, TP.HCM", ["Website"]); // tên đường thật chứa "Website" hiếm nhưng keyword đường
mustKeep("Khu đô thị mới, Phường Đông Hòa, Dĩ An, Bình Dương", ["Đông Hòa"]);

console.log("\n═══ M. mergePlaceRecord tích hợp ═══");
test("merge: source rác không làm hỏng target tốt", () => {
  const target = {
    name: "A",
    address: "123 Đường Lạch Tray, Hải Phòng, Việt Nam",
    phone: "0912345678"
  };
  mergePlaceRecord(target, {
    address: "+84 225 3668 881 Trang web Đường đi",
    phone: ""
  });
  ok(target.address.includes("Lạch Tray"), target.address);
  eq(PF.normalizePhone(target.phone), "0912345678");
});
test("merge: target rác + source tốt → tốt", () => {
  const target = { name: "A", address: "Trang web Đường đi", phone: "" };
  mergePlaceRecord(target, {
    address: "15 phố Huế, Hà Nội",
    phone: "0912111222"
  });
  ok(target.address.includes("Huế"), target.address);
  eq(PF.normalizePhone(target.phone), "0912111222");
});
test("merge: cả hai rác phone-in-addr → recover phone", () => {
  const target = { name: "A", address: "", phone: "" };
  mergePlaceRecord(target, {
    address: "+84 912 345 678 Trang web Đường đi",
    phone: ""
  });
  eq(target.address, "");
  ok(PF.normalizePhone(target.phone).length >= 9, target.phone);
});

console.log("\n═══ N. Matrix fuzz nhỏ ═══");
const phones = ["", "0912345678", "+84912345678"];
const addrs = [
  "+84 225 3668 881 Trang web Đường đi",
  "15 phố Huế, Hà Nội",
  "Đường đi",
  "123 Đường Lạch Tray, Hải Phòng, Việt Nam +84987654321",
  "5.0 (100)",
  ""
];
for (const address of addrs) {
  for (const phone of phones) {
    test(`fuzz addr=${JSON.stringify(address).slice(0, 30)} phone=${phone || "-"}`, () => {
      const p = PF.recoverContactFieldsFromAddress({ address, phone });
      ok(p && typeof p.address === "string");
      if (p.address) {
        ok(!PF.isMapsUiChromeText(p.address) || PF.isValidAddressField(p.address) === false);
        ok(!/^\+?84[\d\s]+Trang web/i.test(p.address), p.address);
        ok(!(/(trang\s*web)/i.test(p.address) && /(đường\s*đi)/i.test(p.address)), p.address);
      }
      if (PF.isValidAddressField(p.address)) {
        ok(!PF.isGarbageAddressText(p.address), p.address);
      }
      const digits = PF.normalizePhone(p.phone);
      ok(digits.length === 0 || (digits.length >= 9 && digits.length <= 12), p.phone);
    });
  }
}

console.log("\n═══ O. Idempotent sanitize ═══");
test("sanitize 2 lần = 1 lần (good)", () => {
  const a = "123 Đường Lạch Tray, Hải Phòng, Việt Nam";
  eq(PF.sanitizeAddressField(PF.sanitizeAddressField(a)), PF.sanitizeAddressField(a));
});
test("sanitize 2 lần = 1 lần (bad)", () => {
  const a = "+84 225 3668 881 Trang web Đường đi";
  eq(PF.sanitizeAddressField(PF.sanitizeAddressField(a)), "");
});

console.log("\n═══ P. Wiring load order ═══");
test("PlaceFields global + grid helpers tồn tại", () => {
  ok(typeof PlaceFields === "object");
  ok(typeof sanitizeAddressField === "function");
  ok(typeof getEnrichProfile === "function");
  ok(typeof sanitizePlace === "function");
  ok(typeof mergePlaceRecord === "function");
  eq(sanitizeAddressField("+84 225 3668 881 Trang web Đường đi"), "");
});

test("manifest có run-lease/place-fields trước grid/content", () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));
  const maps = m.content_scripts.find((s) => (s.js || []).includes("content.js"));
  ok(maps, "maps content_scripts");
  const iLease = maps.js.indexOf("run-lease.js");
  const iPf = maps.js.indexOf("place-fields.js");
  const iGrid = maps.js.indexOf("grid.js");
  const iContent = maps.js.indexOf("content.js");
  ok(iLease >= 0 && iLease < iPf && iPf < iGrid && iGrid < iContent, maps.js.join(","));
});

test("background importScripts và reinject có run-lease/place-fields", () => {
  const bg = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
  ok(/importScripts\([^)]*run-lease\.js/.test(bg));
  ok(/importScripts\([^)]*place-fields\.js/.test(bg));
  ok(/files:\s*\[[^\]]*run-lease\.js[^\]]*place-fields\.js/.test(bg));
});

console.log("\n═══ Q. DOM phone Google Maps + render trễ ═══");
test("data-item-id phone:tel từ popup production", () => {
  const phone = PF.extractPhoneFromContactMeta({
    itemId: "phone:tel:0399866786",
    ariaLabel: "Số điện thoại: +84 399 866 786",
    text: "+84 399 866 786"
  });
  eq(PF.normalizePhone(phone), "0399866786");
});
test("link tel: là fallback hợp lệ", () => {
  const phone = PF.extractPhoneFromContactMeta({
    href: "tel:0979868372",
    ariaLabel: "Gọi số điện thoại"
  });
  eq(PF.normalizePhone(phone), "0979868372");
});
test("aria tiếng Anh có số", () => {
  const phone = PF.extractPhoneFromContactMeta({ ariaLabel: "Phone: +84 912 345 678" });
  eq(PF.normalizePhone(phone), "0912345678");
});
test("nút copy chưa có số vẫn là phone contact", () => {
  ok(PF.isPhoneContactMeta({ ariaLabel: "Sao chép số điện thoại" }));
  eq(PF.extractPhoneFromContactMeta({ ariaLabel: "Sao chép số điện thoại" }), "");
});
test("Gửi tới điện thoại không phải trường SĐT", () => {
  eq(PF.isPhoneContactMeta({ ariaLabel: "Gửi tới điện thoại" }), false);
});
test("contact URI lỗi không làm vỡ parser", () => {
  eq(PF.extractPhoneFromContactMeta({ itemId: "phone:tel:%E0%A4%A" }), "");
});
test("lấy SĐT trực tiếp từ card danh sách", () => {
  const phone = PF.extractPhoneFromListText(
    "Trà Đá Thuỳ · Số 15 Nguyễn Tuân · +84 962 016 929 · Ăn tại chỗ"
  );
  eq(PF.normalizePhone(phone), "0962016929");
});
test("card chỉ có giờ mở cửa không sinh SĐT giả", () => {
  eq(PF.extractPhoneFromListText("Mở cửa 07:00 · Đóng cửa 22:00"), "");
});
test("còn chờ khi address vừa render 500ms", () => {
  ok(PF.shouldKeepWaitingForPhone({
    needPhone: true,
    phone: "",
    elapsedMs: 700,
    contactFieldsAgeMs: 500,
    contactStableMs: 500,
    maxMs: 8000
  }));
});
test("dừng chờ khi contact ổn định đủ lâu và không có phone", () => {
  eq(PF.shouldKeepWaitingForPhone({
    needPhone: true,
    phone: "",
    elapsedMs: 2500,
    contactFieldsAgeMs: 2200,
    contactStableMs: 1200,
    maxMs: 8000
  }), false);
});
test("phần tử phone đã xuất hiện thì tiếp tục chờ text", () => {
  ok(PF.shouldKeepWaitingForPhone({
    needPhone: true,
    phone: "",
    phoneElementExists: true,
    elapsedMs: 3000,
    contactFieldsAgeMs: 2500,
    contactStableMs: 1500,
    maxMs: 8000
  }));
});
test("timeout luôn chặn vòng chờ", () => {
  eq(PF.shouldKeepWaitingForPhone({
    needPhone: true,
    phone: "",
    phoneElementExists: true,
    elapsedMs: 8000,
    maxMs: 8000
  }), false);
});
test("đã có phone thì không chờ", () => {
  eq(PF.shouldKeepWaitingForPhone({
    needPhone: true,
    phone: "0912345678",
    elapsedMs: 200,
    maxMs: 8000
  }), false);
});
test("content wiring có list fallback, tel selector và stable wait", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");
  ok(content.includes("PF.extractPhoneFromListText(item.textContent"));
  ok(content.includes("a[href^=\"tel:\"]"));
  ok(content.includes("PF.shouldKeepWaitingForPhone"));
  ok(/CONTENT_VERSION\s*=\s*58/.test(content));
  ok(content.includes("runScrapeCellMessage"));
  ok(content.includes("verifyDetailMatchesList(listData)"));
});
test("manifest tăng version để web phát hiện bản cũ", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8")
  );
  eq(manifest.version, "0.0.5");
});

console.log("\n────────────────────────────────");
console.log(`Kết quả: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nLỗi:");
  for (const f of failures) console.log("-", f.name, "→", f.message);
  process.exit(1);
}
console.log("ALL PASS — parse địa chỉ/SĐT ổn định trên toàn bộ case kiểm tra.\n");
