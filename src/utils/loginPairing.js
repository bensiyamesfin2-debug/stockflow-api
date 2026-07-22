const { createHash, randomBytes } = require("crypto");

const PAIRING_LIFETIME_MILLISECONDS = 2 * 60 * 1000;

function hashPairingToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function createPairingCredential(now = new Date()) {
  const token = randomBytes(32).toString("base64url");

  return {
    token,
    tokenHash: hashPairingToken(token),
    expiresAt: new Date(now.getTime() + PAIRING_LIFETIME_MILLISECONDS),
  };
}

function getPairingState(pairing, now = new Date()) {
  if (pairing.usedAt) return "USED";
  if (pairing.expiresAt <= now) return "EXPIRED";
  return "PENDING";
}

module.exports = {
  PAIRING_LIFETIME_MILLISECONDS,
  createPairingCredential,
  getPairingState,
  hashPairingToken,
};
