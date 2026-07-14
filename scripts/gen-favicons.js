const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const svg = fs.readFileSync("web/assets/findmap-logo/logo-icon.svg");
const dirs = ["web/assets/icons", "landing/assets"];
const sizes = [16, 48, 128];

(async () => {
  for (const dir of dirs) {
    for (const size of sizes) {
      const name = size === 128 ? "favicon-128.png" : `favicon-${size}.png`;
      await sharp(svg)
        .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(path.join(dir, name));
      console.log(path.join(dir, name));
    }
  }
})();
