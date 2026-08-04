import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import jsQR from "jsqr";
import { QRCodeSVG } from "qrcode.react";
import sharp from "sharp";
import { SIGN_IN_QR_APPEARANCE } from "../lib/sign-in-qr.ts";

test("sign-in QR code decodes to the exact HTTPS role-selection URL", async () => {
  const expected = "https://continuity-ops.example.com/role-selection";
  const svg = renderToStaticMarkup(createElement(QRCodeSVG, {
    ...SIGN_IN_QR_APPEARANCE,
    value: expected,
    title: "Continuity Ops sign-in",
  }));
  const { data, info } = await sharp(Buffer.from(svg))
    .resize({ width: 512, height: 512, fit: "fill", kernel: "nearest" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const decoded = jsQR(pixels, info.width, info.height);

  assert.ok(decoded, "rendered QR code could not be decoded");
  assert.equal(decoded.data, expected);
  assert.equal(new URL(decoded.data).protocol, "https:");
});
