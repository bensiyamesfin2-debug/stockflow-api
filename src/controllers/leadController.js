const prisma = require("../config/prisma");
const {
  normalizeSalesLead,
  normalizeLeadStatus,
} = require("../utils/salesLead");

const requestsByIp = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT = 5;

function acceptsPublicRequest(ip) {
  const now = Date.now();
  const recent = (requestsByIp.get(ip) || []).filter(
    (timestamp) => now - timestamp < RATE_WINDOW_MS
  );

  if (recent.length >= RATE_LIMIT) {
    requestsByIp.set(ip, recent);
    return false;
  }

  recent.push(now);
  requestsByIp.set(ip, recent);
  if (requestsByIp.size > 1000) {
    for (const [key, timestamps] of requestsByIp) {
      if (!timestamps.some((timestamp) => now - timestamp < RATE_WINDOW_MS)) {
        requestsByIp.delete(key);
      }
    }
  }
  return true;
}

async function createLead(req, res) {
  const successResponse = {
    success: true,
    message: "Thanks — your demo request is saved. We will contact you soon.",
  };

  if (String(req.body.website || "").trim()) {
    return res.status(201).json(successResponse);
  }

  if (!acceptsPublicRequest(req.ip || "unknown")) {
    return res.status(429).json({
      success: false,
      message: "Too many requests. Please try again in about an hour.",
    });
  }

  const normalized = normalizeSalesLead(req.body);
  if (normalized.errors) {
    return res.status(400).json({
      success: false,
      message: normalized.errors[0],
      details: normalized.errors,
    });
  }

  await prisma.salesLead.create({ data: normalized.data });
  return res.status(201).json(successResponse);
}

async function listLeads(req, res) {
  const leads = await prisma.salesLead.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return res.json({ success: true, data: { leads } });
}

async function updateLeadStatus(req, res) {
  const id = Number(req.params.id);
  const status = normalizeLeadStatus(req.body.status);

  if (!Number.isInteger(id) || id < 1 || !status) {
    return res.status(400).json({
      success: false,
      message: "Choose a valid demo request status",
    });
  }

  const existing = await prisma.salesLead.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({
      success: false,
      message: "Demo request not found",
    });
  }

  const lead = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.salesLead.update({
      where: { id },
      data: { status },
    });
    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "UPDATE_SALES_LEAD",
        entityType: "SALES_LEAD",
        entityId: id,
        details: { status },
      },
    });
    return updated;
  });

  return res.json({ success: true, data: { lead } });
}

module.exports = {
  createLead,
  listLeads,
  updateLeadStatus,
};
