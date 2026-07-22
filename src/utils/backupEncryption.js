const {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} = require("crypto");

const ALGORITHM = "aes-256-gcm";

function encryptJsonBackup(payload, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    format: "stockflow-encrypted-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    encryption: {
      algorithm: ALGORITHM,
      keyDerivation: "scrypt",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authenticationTag: cipher.getAuthTag().toString("base64"),
    },
    data: ciphertext.toString("base64"),
  };
}

function decryptJsonBackup(envelope, passphrase) {
  if (
    envelope?.format !== "stockflow-encrypted-backup" ||
    envelope?.version !== 1 ||
    envelope?.encryption?.algorithm !== ALGORITHM
  ) {
    throw new Error("Unsupported StockFlow backup format");
  }

  const salt = Buffer.from(envelope.encryption.salt, "base64");
  const iv = Buffer.from(envelope.encryption.iv, "base64");
  const authenticationTag = Buffer.from(
    envelope.encryption.authenticationTag,
    "base64"
  );
  const key = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authenticationTag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString("utf8"));
}

module.exports = { encryptJsonBackup, decryptJsonBackup };
