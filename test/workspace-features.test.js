const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { generateSecret, makeCode, provisioningUri, verifyCode } = require("../src/utils/totp");

test("TOTP secrets produce a current six-digit authenticator challenge", () => {
  const secret = generateSecret();
  const now = Date.UTC(2026, 6, 30, 12, 0, 0);
  const code = makeCode(secret, Math.floor(now / 30_000));

  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.match(code, /^\d{6}$/);
  assert.equal(verifyCode(secret, code, now), true);
  assert.equal(verifyCode(secret, "000000", now), false);
  assert.match(provisioningUri(secret, "mesfin"), /^otpauth:\/\/totp\/StockFlow%3Amesfin\?/);
});

test("workspace API exposes durable productivity, template, attachment, and delivery endpoints", () => {
  const routes = readFileSync(path.join(__dirname, "../src/routes/workspaceRoutes.js"), "utf8");
  const app = readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
  const schema = readFileSync(path.join(__dirname, "../prisma/schema.prisma"), "utf8");

  assert.match(routes, /router\.get\("\/search"/);
  assert.match(routes, /router\.post\("\/notes"/);
  assert.match(routes, /router\.post\("\/calendar"/);
  assert.match(routes, /router\.post\("\/invoice-templates"/);
  assert.match(routes, /router\.post\("\/attachments"/);
  assert.match(routes, /router\.post\("\/delivery-link"/);
  assert.match(app, /app\.use\("\/api\/workspace", workspaceRoutes\)/);
  for (const model of ["WorkspaceSettings", "UserPreference", "WorkspaceNote", "CalendarEvent", "Favorite", "FileAttachment", "InvoiceTemplate"]) {
    assert.match(schema, new RegExp(`model ${model}`));
  }
});
