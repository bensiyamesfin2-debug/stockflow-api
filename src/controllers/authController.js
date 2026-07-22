const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");
const { validateNewUser, validatePassword } = require("./userController");

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const ACCOUNT_LOCK_MINUTES = 15;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("stockflow-invalid-password", 12);

function setupOrigins() {
  return new Set(
    String(process.env.CLIENT_URLS || process.env.CLIENT_URL || "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean)
  );
}

async function getSetupStatus(req, res) {
  const userCount = await prisma.user.count();

  return res.json({
    success: true,
    data: { needsSetup: userCount === 0 },
  });
}

async function initializeAdmin(req, res) {
  const origin = String(req.headers.origin || "").replace(/\/$/, "");

  if (!origin || !setupOrigins().has(origin)) {
    return res.status(403).json({
      success: false,
      message: "Administrator setup must be completed from the StockFlow website",
    });
  }

  const fullName = String(req.body.fullName || "").trim();
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const validationError = validateNewUser({
    fullName,
    username,
    password,
    role: "ADMIN",
  });

  if (validationError) {
    return res.status(400).json({ success: false, message: validationError });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const user = await prisma.$transaction(
      async (transaction) => {
        if ((await transaction.user.count()) > 0) return null;

        const createdUser = await transaction.user.create({
          data: { fullName, username, passwordHash, role: "ADMIN" },
          select: {
            id: true,
            fullName: true,
            username: true,
            role: true,
          },
        });

        await transaction.auditLog.create({
          data: {
            userId: createdUser.id,
            action: "INITIALIZE_CLOUD_ADMIN",
            entityType: "USER",
            entityId: createdUser.id,
          },
        });

        return createdUser;
      },
      { isolationLevel: "Serializable" }
    );

    if (!user) {
      return res.status(409).json({
        success: false,
        message: "StockFlow has already been initialized",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Administrator created. You can now sign in.",
      data: { user },
    });
  } catch (error) {
    if (error.code === "P2002" || error.code === "P2034") {
      return res.status(409).json({
        success: false,
        message: "StockFlow has already been initialized",
      });
    }

    throw error;
  }
}

async function login(req, res) {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: "Username and password are required",
    });
  }

  const user = await prisma.user.findUnique({ where: { username } });
  const now = new Date();

  if (user?.lockedUntil && user.lockedUntil > now) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 1000)
    );
    res.setHeader("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({
      success: false,
      message: "Too many failed attempts. Try again in a few minutes.",
    });
  }

  const passwordIsValid = await bcrypt.compare(
    password,
    user?.passwordHash || DUMMY_PASSWORD_HASH
  );

  if (!user || !passwordIsValid) {
    if (user) {
      const previousAttempts =
        user.lockedUntil && user.lockedUntil <= now
          ? 0
          : user.failedLoginAttempts;
      const failedLoginAttempts = previousAttempts + 1;
      const shouldLock = failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS;
      const lockedUntil = shouldLock
        ? new Date(now.getTime() + ACCOUNT_LOCK_MINUTES * 60 * 1000)
        : null;

      await prisma.$transaction([
        prisma.user.update({
          where: { id: user.id },
          data: { failedLoginAttempts, lockedUntil },
        }),
        prisma.auditLog.create({
          data: {
            userId: user.id,
            action: shouldLock ? "ACCOUNT_LOCKED" : "LOGIN_FAILED",
            entityType: "USER",
            entityId: user.id,
            details: { failedLoginAttempts },
          },
        }),
      ]);

      if (shouldLock) {
        res.setHeader("Retry-After", String(ACCOUNT_LOCK_MINUTES * 60));
        return res.status(429).json({
          success: false,
          message: "Too many failed attempts. Try again in 15 minutes.",
        });
      }
    }

    return res.status(401).json({
      success: false,
      message: "Invalid username or password",
    });
  }

  if (!user.isActive) {
    return res.status(403).json({
      success: false,
      message: "This account is inactive",
    });
  }

  const authenticatedAt = new Date();
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: authenticatedAt,
      },
    }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "LOGIN",
        entityType: "USER",
        entityId: user.id,
      },
    }),
  ]);

  const token = jwt.sign(
    { role: user.role, tokenVersion: user.tokenVersion },
    process.env.JWT_SECRET,
    {
      subject: String(user.id),
      expiresIn: process.env.JWT_EXPIRES_IN || "8h",
    }
  );

  return res.json({
    success: true,
    message: "Login successful",
    data: {
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        username: user.username,
        role: user.role,
      },
    },
  });
}

async function changePassword(req, res) {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      message: "Current password and new password are required",
    });
  }

  const passwordError = validatePassword(newPassword, req.user.username);
  if (passwordError) {
    return res.status(400).json({ success: false, message: passwordError });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  const currentPasswordIsValid = await bcrypt.compare(
    currentPassword,
    user.passwordHash
  );

  if (!currentPasswordIsValid) {
    return res.status(401).json({
      success: false,
      message: "Current password is incorrect",
    });
  }

  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    return res.status(400).json({
      success: false,
      message: "Choose a password you have not already been using",
    });
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        tokenVersion: { increment: 1 },
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "CHANGE_PASSWORD",
        entityType: "USER",
        entityId: user.id,
      },
    }),
  ]);

  return res.json({
    success: true,
    message: "Password changed. Sign in again with your new password.",
  });
}

function getCurrentUser(req, res) {
  return res.json({
    success: true,
    data: { user: req.user },
  });
}

module.exports = {
  login,
  getCurrentUser,
  getSetupStatus,
  initializeAdmin,
  changePassword,
};
