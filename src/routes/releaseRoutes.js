const express = require("express");
const {
  listPendingReleases,
  createRelease,
  listReleases,
} = require("../controllers/releaseController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate, authorizeRoles("ADMIN", "INVENTORY_STAFF"));
router.get("/pending", listPendingReleases);
router.get("/", listReleases);
router.post("/", createRelease);

module.exports = router;
