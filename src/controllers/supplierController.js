const prisma = require("../config/prisma");
const { normalizeOptionalText } = require("../utils/validation");

function normalizeSupplier(body, partial = false) {
  const data = {};
  const errors = [];
  if (!partial || body.name !== undefined) {
    const name = String(body.name || "").trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 150) errors.push("Supplier name must be between 2 and 150 characters");
    else data.name = name;
  }
  for (const [field, limit, label] of [
    ["contactName", 150, "Contact name"],
    ["phone", 40, "Phone"],
    ["email", 254, "Email"],
    ["address", 1000, "Address"],
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

async function listSuppliers(req, res) {
  const search = String(req.query.search || "").trim();
  const where = {
    ...(req.query.active === "all" ? {} : { isActive: req.query.active === "false" ? false : true }),
    ...(search ? { OR: [
      { name: { contains: search, mode: "insensitive" } },
      { contactName: { contains: search, mode: "insensitive" } },
      { phone: { contains: search } },
    ] } : {}),
  };
  const suppliers = await prisma.supplier.findMany({
    where,
    include: { _count: { select: { purchaseOrders: true, stockReceipts: true } } },
    orderBy: { name: "asc" },
    take: 500,
  });
  return res.json({ success: true, data: { suppliers } });
}

async function createSupplier(req, res) {
  const { data, errors } = normalizeSupplier(req.body);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
  try {
    const supplier = await prisma.$transaction(async (transaction) => {
      const created = await transaction.supplier.create({ data });
      await transaction.auditLog.create({
        data: { userId: req.user.id, action: "CREATE_SUPPLIER", entityType: "SUPPLIER", entityId: created.id, details: { name: created.name } },
      });
      return created;
    });
    return res.status(201).json({ success: true, message: "Supplier created", data: { supplier } });
  } catch (error) {
    if (error.code === "P2002") return res.status(409).json({ success: false, message: "A supplier with that name already exists" });
    throw error;
  }
}

async function updateSupplier(req, res) {
  const supplierId = Number(req.params.id);
  if (!Number.isInteger(supplierId) || supplierId <= 0) return res.status(400).json({ success: false, message: "Invalid supplier ID" });
  const { data, errors } = normalizeSupplier(req.body, true);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
  if (!Object.keys(data).length) return res.status(400).json({ success: false, message: "Provide at least one supplier field to update" });
  try {
    const supplier = await prisma.$transaction(async (transaction) => {
      const existing = await transaction.supplier.findUnique({ where: { id: supplierId } });
      if (!existing) return null;
      const updated = await transaction.supplier.update({ where: { id: supplierId }, data });
      await transaction.auditLog.create({
        data: { userId: req.user.id, action: "UPDATE_SUPPLIER", entityType: "SUPPLIER", entityId: supplierId, details: { fields: Object.keys(data) } },
      });
      return updated;
    });
    if (!supplier) return res.status(404).json({ success: false, message: "Supplier not found" });
    return res.json({ success: true, message: "Supplier updated", data: { supplier } });
  } catch (error) {
    if (error.code === "P2002") return res.status(409).json({ success: false, message: "A supplier with that name already exists" });
    throw error;
  }
}

module.exports = { listSuppliers, createSupplier, updateSupplier, normalizeSupplier };
