const prisma = require("../config/prisma");

async function runSerializableTransaction(work, maximumAttempts = 3) {
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      const canRetry = error.code === "P2034" && attempt < maximumAttempts;

      if (!canRetry) {
        throw error;
      }
    }
  }

  throw new Error("Transaction retry limit reached");
}

module.exports = { runSerializableTransaction };
