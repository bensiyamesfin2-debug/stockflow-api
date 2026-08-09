const bcrypt = require("bcrypt");
const prisma = require("../config/prisma");
const HttpError = require("../utils/HttpError");
const { runSerializableTransaction } = require("../utils/transaction");

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

  if (
    !Number.isInteger(userId) ||
    userId <= 0 ||
    typeof isActive !== "boolean"
  ) {
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

  if (existingUser.isActive === isActive) {
    return res.json({
      success: true,
      message: `User is already ${isActive ? "active" : "inactive"}`,
      data: {
        user: {
          id: existingUser.id,
          fullName: existingUser.fullName,
          username: existingUser.username,
          role: existingUser.role,
          isActive: existingUser.isActive,
        },
      },
    });
  }

  const user = await runSerializableTransaction(async (transaction) => {
    if (!isActive && existingUser.role === "ADMIN") {
      const activeAdministratorCount = await transaction.user.count({
        where: { role: "ADMIN", isActive: true },
      });

      if (activeAdministratorCount <= 1) {
        throw new HttpError(
          409,
          "At least one active administrator account is required"
        );
      }
    }

    const updatedUser = await transaction.user.update({
      where: { id: userId },
      data: {
        isActive,
        // Status changes are a security boundary. Invalidate every session so
        // a previously deactivated account cannot reuse an old token later.
        tokenVersion: { increment: 1 },
      },
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

async function resetUserPassword(req, res) {
  const userId = Number(req.params.id);
  const administratorPassword = String(req.body.administratorPassword || "");
  const temporaryPassword = String(req.body.temporaryPassword || "");

  if (!Number.isInteger(userId) || userId <= 0) {
    throw new HttpError(400, "A valid user ID is required");
  }

  const [administrator, target] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.user.id } }),
    prisma.user.findUnique({ where: { id: userId } }),
  ]);
  if (!administrator || !(await bcrypt.compare(administratorPassword, administrator.passwordHash))) {
    throw new HttpError(401, "Your administrator password is incorrect");
  }
  if (!target) throw new HttpError(404, "User not found");

  const passwordError = validatePassword(temporaryPassword, target.username);
  if (passwordError) throw new HttpError(400, passwordError);
  if (await bcrypt.compare(temporaryPassword, target.passwordHash)) {
    throw new HttpError(400, "The temporary password must be different from the current password");
  }

  const passwordHash = await bcrypt.hash(temporaryPassword, 12);
  await runSerializableTransaction(async (transaction) => {
    await transaction.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        tokenVersion: { increment: 1 },
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "RESET_USER_PASSWORD",
        entityType: "USER",
        entityId: userId,
        details: { forcedSessionLogout: true },
      },
    });
  });

  return res.json({
    success: true,
    message: "Password reset. The user has been signed out on every device.",
  });
}

module.exports = {
  createUser,
  listUsers,
  updateUserStatus,
  resetUserPassword,
  validateNewUser,
  validatePassword,
};
