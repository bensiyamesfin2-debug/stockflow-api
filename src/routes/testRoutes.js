const express = require("express");
const prisma = require("../config/prisma");

const router = express.Router();

router.get("/database", async (req, res) => {
  try {
    const [database] = await prisma.$queryRaw`
      SELECT current_database() AS database_name, NOW() AS current_time
    `;

    res.json({
      success: true,
      message: "Prisma database connection successful",
      data: database,
    });
  } catch (error) {
    console.error("Database health check failed:", error);

    res.status(500).json({
      success: false,
      message: "Database connection failed",
    });
  }
});

module.exports = router;
