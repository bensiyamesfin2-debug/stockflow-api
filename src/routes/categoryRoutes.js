const express = require("express");
const {
  listCategories,
  createCategory,
  updateCategory,
} = require("../controllers/categoryController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate);
router.get("/", listCategories);
router.post("/", authorizeRoles("ADMIN"), createCategory);
router.patch("/:id", authorizeRoles("ADMIN"), updateCategory);

module.exports = router;
