const express = require("express");
const {
  createUser,
  listUsers,
  updateUserStatus,
} = require("../controllers/userController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate, authorizeRoles("ADMIN"));
router.get("/", listUsers);
router.post("/", createUser);
router.patch("/:id/status", updateUserStatus);

module.exports = router;
