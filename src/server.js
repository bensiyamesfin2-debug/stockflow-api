require("dotenv").config();

const http = require("http");
const app = require("./app");
const prisma = require("./config/prisma");

const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

server.requestTimeout = 30_000;
server.headersTimeout = 35_000;

function validateEnvironment() {
  const required = ["DATABASE_URL", "JWT_SECRET"];

  if (process.env.NODE_ENV === "production") {
    required.push("CLIENT_URLS");
  }

  const missing = required.filter((name) => !process.env[name]);

  if (missing.length) {
    throw new Error(`Missing required environment settings: ${missing.join(", ")}`);
  }

  const minimumSecretLength = process.env.NODE_ENV === "production" ? 32 : 16;

  if (process.env.JWT_SECRET.length < minimumSecretLength) {
    throw new Error(
      `JWT_SECRET must contain at least ${minimumSecretLength} characters`
    );
  }
}

async function startServer() {
  try {
    validateEnvironment();
    await prisma.$connect();

    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Unable to start the server:", error);
    process.exit(1);
  }
}

function shutDown(signal) {
  console.log(`${signal} received. Shutting down...`);

  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutDown("SIGINT"));
process.on("SIGTERM", () => shutDown("SIGTERM"));

startServer();
