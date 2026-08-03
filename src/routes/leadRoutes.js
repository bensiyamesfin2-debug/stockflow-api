const express = require("express");
const {
  createLead,
  listLeads,
  updateLeadStatus,
} = require("../controllers/leadController");
const { authenticate, authorizePlatformOwner } = require("../middleware/auth");

const router = express.Router();

router.post("/", createLead);
router.get("/", authenticate, authorizePlatformOwner, listLeads);
router.patch(
  "/:id/status",
  authenticate,
  authorizePlatformOwner,
  updateLeadStatus
);

module.exports = router;
