import assert from "node:assert/strict";
import test from "node:test";
import { resolvePublicSiteOrigin, roleSelectionUrl } from "../lib/public-site-url.ts";

test("configured public origin produces the stable role-selection URL", () => {
  assert.equal(
    roleSelectionUrl({ configuredOrigin: "https://continuity-ops.example.com" }),
    "https://continuity-ops.example.com/role-selection",
  );
});

test("forwarded deployment headers produce an HTTPS role-selection URL", () => {
  assert.equal(
    roleSelectionUrl({
      forwardedHost: "continuity-ops.example.com, internal-proxy",
      forwardedProtocol: "https, http",
    }),
    "https://continuity-ops.example.com/role-selection",
  );
});

test("configured origin is authoritative and fails closed when invalid", () => {
  assert.equal(resolvePublicSiteOrigin({
    configuredOrigin: "https://continuity-ops.example.com/unexpected-path",
    forwardedHost: "fallback.example.com",
    forwardedProtocol: "https",
  }), null);
});

test("public origin rejects insecure, local, and credential-bearing URLs", () => {
  assert.equal(resolvePublicSiteOrigin({ configuredOrigin: "http://continuity-ops.example.com" }), null);
  assert.equal(resolvePublicSiteOrigin({ configuredOrigin: "https://localhost" }), null);
  assert.equal(resolvePublicSiteOrigin({ configuredOrigin: "https://user@example.com" }), null);
  assert.equal(resolvePublicSiteOrigin({ host: "continuity-ops.example.com", forwardedProtocol: "http" }), null);
  assert.equal(resolvePublicSiteOrigin({ host: "user@example.com", forwardedProtocol: "https" }), null);
});
