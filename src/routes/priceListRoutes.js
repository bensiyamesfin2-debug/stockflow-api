const express = require("express");
const { listPriceLists, createPriceList, updatePriceList } = require("../controllers/priceListController");
const { authenticate, authorizeRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate);
router.get("/", authorizeRoles("ADMIN", "CASHIER"), listPriceLists);
router.post("/", authorizeRoles("ADMIN"), createPriceList);
router.patch("/:id", authorizeRoles("ADMIN"), updatePriceList);

module.exports = router;
