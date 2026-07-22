const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");
const { validateNewUser } = require("./userController");

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
  const passwordIsValid = user
    ? await bcrypt.compare(password, user.passwordHash)
    : false;

  if (!user || !passwordIsValid) {
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

  const token = jwt.sign(
    { role: user.role },
    process.env.JWT_SECRET,
    {
      subject: String(user.id),
      expiresIn: process.env.JWT_EXPIRES_IN || "8h",
    }
  );

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "LOGIN",
      entityType: "USER",
      entityId: user.id,
    },
  });

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
};
