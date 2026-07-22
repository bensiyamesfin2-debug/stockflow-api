const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");

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
};
