const prisma = require("../config/prisma");
const HttpError = require("../utils/HttpError");
const { deliverWhatsAppText, saleWhatsAppMessage } = require("../utils/whatsapp");

async function sendSaleWhatsApp(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid sale ID");
  const sale = await prisma.sale.findUnique({ where: { id }, include: { customer: { select: { phone: true } } } });
  if (!sale) throw new HttpError(404, "Sale not found");
  if (req.user.role === "CASHIER" && sale.cashierId !== req.user.id) throw new HttpError(403, "You can only message your own sale");
  const delivery = await deliverWhatsAppText({ phone: sale.customer?.phone, message: saleWhatsAppMessage(sale) });
  await prisma.auditLog.create({ data: { userId: req.user.id, action: "SEND_SALE_WHATSAPP", entityType: "SALE", entityId: sale.id, details: { delivered: delivery.delivered, available: delivery.available } } });
  return res.json({ success: true, message: delivery.delivered ? "Order message sent automatically on WhatsApp" : "WhatsApp order message is ready to send", data: delivery });
}

module.exports = { sendSaleWhatsApp };
