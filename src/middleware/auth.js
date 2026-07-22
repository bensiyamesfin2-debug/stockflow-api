const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");

async function authenticate(req, res, next) {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  const token = authorization.slice("Bearer ".length).trim();

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const userId = Number(payload.sub);

    if (!Number.isInteger(userId)) {
      throw new Error("Invalid token subject");
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        username: true,
        role: true,
        isActive: true,
        tokenVersion: true,
      },
    });

    if (
      !user ||
      !user.isActive ||
      payload.tokenVersion !== user.tokenVersion
    ) {
      return res.status(401).json({
        success: false,
        message: "Account is unavailable",
      });
    }

    const { tokenVersion, ...authenticatedUser } = user;
    req.user = authenticatedUser;
    return next();
  } catch (error) {
    if (error.name !== "JsonWebTokenError" && error.name !== "TokenExpiredError") {
      console.error("Authentication failed:", error);
    }

    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
}

function authorizeRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to perform this action",
      });
    }

    return next();
  };
}

module.exports = {
  authenticate,
  authorizeRoles,
};
