const express = require("express");
const controller = require("../controllers/quotationController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate, authorizeRoles("ADMIN", "CASHIER"));
router.get("/", controller.listQuotations);
router.post("/", controller.createQuotation);
router.patch("/:id", controller.updateQuotation);
router.post("/:id/whatsapp", controller.sendQuotationWhatsApp);

module.exports = router;
