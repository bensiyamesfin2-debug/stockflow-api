const express = require("express");
const {
  createLead,
  listLeads,
  updateLeadStatus,
} = require("../controllers/leadController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.post("/", createLead);
router.get("/", authenticate, authorizeRoles("ADMIN"), listLeads);
router.patch(
  "/:id/status",
  authenticate,
  authorizeRoles("ADMIN"),
  updateLeadStatus
);

module.exports = router;
