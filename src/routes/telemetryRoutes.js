const express = require("express");
const { heartbeat, reportError } = require("../controllers/telemetryController");

const router = express.Router();
router.post("/heartbeat", heartbeat);
router.post("/error", reportError);

module.exports = router;
