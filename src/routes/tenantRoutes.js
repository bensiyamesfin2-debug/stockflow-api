const express = require("express");
const { listTenants, resolveTenant, createTenant, updateTenant, provisionTenant, operationsOverview, rotateMonitoringToken, resolveIncident } = require("../controllers/tenantController");
const { authenticate, authorizePlatformOwner, authorizeControlPlane } = require("../middleware/auth");

const router = express.Router();

router.get("/resolve/:slug", resolveTenant);
router.use(authenticate, authorizePlatformOwner, authorizeControlPlane);
router.get("/", listTenants);
router.get("/operations", operationsOverview);
router.post("/", createTenant);
router.post("/:id/provision", provisionTenant);
router.post("/:id/monitoring-token", rotateMonitoringToken);
router.patch("/:id/errors/:incidentId/resolve", resolveIncident);
router.patch("/:id", updateTenant);

module.exports = router;
