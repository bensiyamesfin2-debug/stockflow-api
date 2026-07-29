const prisma = require("../config/prisma");
const { normalizeOptionalText } = require("../utils/validation");

function normalizeCustomer(body, partial = false) {
  const data = {};
  const errors = [];
  if (!partial || body.name !== undefined) {
    const name = String(body.name || "").trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 150) errors.push("Customer name must be between 2 and 150 characters");
    else data.name = name;
  }
  for (const [field, limit, label] of [
    ["phone", 40, "Phone"],
    ["email", 254, "Email"],
    ["address", 1000, "Address"],
    ["notes", 2000, "Notes"],
  ]) {
    if (body[field] === undefined) continue;
    if (body[field] === null || body[field] === "") data[field] = null;
    else {
      const value = normalizeOptionalText(body[field], limit);
      if (!value) errors.push(`${label} cannot exceed ${limit} characters`);
      else if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors.push("Email address is invalid");
      else data[field] = value;
    }
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") errors.push("isActive must be true or false");
    else data.isActive = body.isActive;
  }
  return { data, errors };
}

async function listCustomers(req, res) {
  const search = String(req.query.search || "").trim();
  const canViewInactive = req.user.role === "ADMIN";
  const activeFilter = canViewInactive && req.query.active === "all"
    ? {}
    : {
        isActive:
          canViewInactive && req.query.active === "false"
            ? false
            : true,
      };
  const where = {
    ...activeFilter,
    ...(search ? { OR: [
      { name: { contains: search, mode: "insensitive" } },
      { phone: { contains: search } },
      { email: { contains: search, mode: "insensitive" } },
    ] } : {}),
  };
  const customers = await prisma.customer.findMany({
    where,
    include: { _count: { select: { sales: true } } },
    orderBy: { name: "asc" },
    take: 500,
  });
  return res.json({ success: true, data: { customers } });
}

async function createCustomer(req, res) {
  const { data, errors } = normalizeCustomer(req.body);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
  const customer = await prisma.$transaction(async (transaction) => {
    const created = await transaction.customer.create({ data });
    await transaction.auditLog.create({
      data: { userId: req.user.id, action: "CREATE_CUSTOMER", entityType: "CUSTOMER", entityId: created.id, details: { name: created.name } },
    });
    return created;
  });
  return res.status(201).json({ success: true, message: "Customer created", data: { customer } });
}

async function updateCustomer(req, res) {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId) || customerId <= 0) return res.status(400).json({ success: false, message: "Invalid customer ID" });
  const { data, errors } = normalizeCustomer(req.body, true);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
  if (!Object.keys(data).length) return res.status(400).json({ success: false, message: "Provide at least one customer field to update" });
  const customer = await prisma.$transaction(async (transaction) => {
    const existing = await transaction.customer.findUnique({ where: { id: customerId } });
    if (!existing) return null;
    const updated = await transaction.customer.update({ where: { id: customerId }, data });
    await transaction.auditLog.create({
      data: { userId: req.user.id, action: "UPDATE_CUSTOMER", entityType: "CUSTOMER", entityId: customerId, details: { fields: Object.keys(data) } },
    });
    return updated;
  });
  if (!customer) return res.status(404).json({ success: false, message: "Customer not found" });
  return res.json({ success: true, message: "Customer updated", data: { customer } });
}

module.exports = { listCustomers, createCustomer, updateCustomer, normalizeCustomer };
