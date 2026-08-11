const express = require("express");
const { listTenants, createTenant, updateTenant } = require("../controllers/tenantController");
const { authenticate, authorizePlatformOwner, authorizeControlPlane } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate, authorizePlatformOwner, authorizeControlPlane);
router.get("/", listTenants);
router.post("/", createTenant);
router.patch("/:id", updateTenant);

module.exports = router;
