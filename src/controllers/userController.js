const bcrypt = require("bcrypt");
const prisma = require("../config/prisma");

const ALLOWED_ROLES = new Set(["ADMIN", "CASHIER", "INVENTORY_STAFF"]);
const USERNAME_PATTERN = /^[a-z0-9._-]{3,50}$/;

function validatePassword(password, username = "") {
  if (password.length < 10 || password.length > 128) {
    return "Password must be between 10 and 128 characters";
  }

  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    return "Password must not contain the username";
  }

  return null;
}

function validateNewUser({ fullName, username, password, role }) {
  if (fullName.length < 2 || fullName.length > 150) {
    return "Full name must be between 2 and 150 characters";
  }

  if (!USERNAME_PATTERN.test(username)) {
    return "Username must be 3-50 characters and use only letters, numbers, dots, underscores, or hyphens";
  }

  const passwordError = validatePassword(password, username);
  if (passwordError) return passwordError;

  if (!ALLOWED_ROLES.has(role)) {
    return "Role must be ADMIN, CASHIER, or INVENTORY_STAFF";
  }

  return null;
}

async function createUser(req, res) {
  const fullName = String(req.body.fullName || "").trim();
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const role = String(req.body.role || "").trim().toUpperCase();
  const validationError = validateNewUser({
    fullName,
    username,
    password,
    role,
  });

  if (validationError) {
    return res.status(400).json({
      success: false,
      message: validationError,
    });
  }

  const existingUser = await prisma.user.findUnique({ where: { username } });

  if (existingUser) {
    return res.status(409).json({
      success: false,
      message: "That username is already in use",
    });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const user = await prisma.$transaction(async (transaction) => {
      const createdUser = await transaction.user.create({
        data: { fullName, username, passwordHash, role },
        select: {
          id: true,
          fullName: true,
          username: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
      });

      await transaction.auditLog.create({
        data: {
          userId: req.user.id,
          action: "CREATE_USER",
          entityType: "USER",
          entityId: createdUser.id,
          details: { role: createdUser.role },
        },
      });

      return createdUser;
    });

    return res.status(201).json({
      success: true,
      message: "User created successfully",
      data: { user },
    });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({
        success: false,
        message: "That username is already in use",
      });
    }

    throw error;
  }
}

async function listUsers(req, res) {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      fullName: true,
      username: true,
      role: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { fullName: "asc" },
  });

  return res.json({
    success: true,
    data: { users },
  });
}

async function updateUserStatus(req, res) {
  const userId = Number(req.params.id);
  const isActive = req.body.isActive;

  if (!Number.isInteger(userId) || typeof isActive !== "boolean") {
    return res.status(400).json({
      success: false,
      message: "A valid user ID and boolean isActive value are required",
    });
  }

  if (userId === req.user.id && !isActive) {
    return res.status(400).json({
      success: false,
      message: "You cannot deactivate your own account",
    });
  }

  const existingUser = await prisma.user.findUnique({ where: { id: userId } });

  if (!existingUser) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  const user = await prisma.$transaction(async (transaction) => {
    const updatedUser = await transaction.user.update({
      where: { id: userId },
      data: { isActive },
      select: {
        id: true,
        fullName: true,
        username: true,
        role: true,
        isActive: true,
      },
    });

    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: isActive ? "ACTIVATE_USER" : "DEACTIVATE_USER",
        entityType: "USER",
        entityId: userId,
      },
    });

    return updatedUser;
  });

  return res.json({
    success: true,
    message: `User ${isActive ? "activated" : "deactivated"} successfully`,
    data: { user },
  });
}

module.exports = {
  createUser,
  listUsers,
  updateUserStatus,
  validateNewUser,
  validatePassword,
};
