function normalizeWhatsAppPhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `251${digits.slice(1)}`;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function buildWhatsAppUrl(phone, message) {
  const normalized = normalizeWhatsAppPhone(phone);
  return normalized ? `https://wa.me/${normalized}?text=${encodeURIComponent(message)}` : null;
}

async function deliverWhatsAppText({ phone, message }) {
  const url = buildWhatsAppUrl(phone, message);
  if (!url) return { delivered: false, available: false, url: null, reason: "A valid customer phone number is required" };
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) return { delivered: false, available: true, url, mode: "READY_TO_SEND" };

  try {
    const response = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || "v22.0"}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: normalizeWhatsAppPhone(phone), type: "text", text: { body: message } }),
    });
    if (!response.ok) throw new Error(`WhatsApp delivery returned ${response.status}`);
    return { delivered: true, available: true, url, mode: "AUTOMATIC" };
  } catch (error) {
    console.error("WhatsApp delivery could not be completed:", error.message);
    return { delivered: false, available: true, url, mode: "READY_TO_SEND" };
  }
}

function saleWhatsAppMessage(sale) {
  return `Bensiya PLC: your order ${sale.saleNumber} has been recorded. Total: ETB ${sale.totalAmount}. We will prepare your granite for release. Thank you.`;
}

function quotationWhatsAppMessage(quotation) {
  const validity = quotation.validUntil ? ` Valid until ${new Date(quotation.validUntil).toLocaleDateString("en-GB")}.` : "";
  return `Bensiya PLC quotation ${quotation.quoteNumber}: ${quotation.totalAreaSqm} m² · ETB ${quotation.totalAmount}.${validity} Reply to confirm or visit us to proceed.`;
}

module.exports = { normalizeWhatsAppPhone, buildWhatsAppUrl, deliverWhatsAppText, saleWhatsAppMessage, quotationWhatsAppMessage };
