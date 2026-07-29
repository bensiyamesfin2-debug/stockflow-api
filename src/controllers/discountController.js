const prisma = require("../config/prisma");
const { normalizeMoney } = require("../utils/validation");
const { moneyToCents, centsToMoney } = require("../utils/money");
const { calculateDiscountCents } = require("../utils/discounts");

const TYPES = new Set(["PERCENTAGE", "FIXED"]);

function normalizeDiscount(body, partial = false) {
  const data = {};
  const errors = [];
  if (!partial || body.code !== undefined) {
    const code = String(body.code || "").trim().toUpperCase().replace(/\s+/g, "-");
    if (!/^[A-Z0-9][A-Z0-9_-]{1,49}$/.test(code)) errors.push("Discount code must be 2–50 letters, numbers, underscores, or hyphens");
    else data.code = code;
  }
  if (!partial || body.name !== undefined) {
    const name = String(body.name || "").trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 150) errors.push("Discount name must be between 2 and 150 characters");
    else data.name = name;
  }
  if (!partial || body.type !== undefined) {
    const type = String(body.type || "").toUpperCase();
    if (!TYPES.has(type)) errors.push("Discount type must be PERCENTAGE or FIXED");
    else data.type = type;
  }
  if (!partial || body.value !== undefined) {
    const value = normalizeMoney(body.value);
    if (value === null || moneyToCents(value) <= 0n) errors.push("Discount value must be greater than zero");
    else data.value = value;
  }
  for (const [source, target, label] of [
    ["minimumAmount", "minimumAmount", "Minimum amount"],
    ["maximumDiscount", "maximumDiscount", "Maximum discount"],
  ]) {
    if (body[source] === undefined) continue;
    if (body[source] === null || body[source] === "") data[target] = null;
    else {
      const value = normalizeMoney(body[source]);
      if (value === null || moneyToCents(value) < 0n) errors.push(`${label} is invalid`);
      else data[target] = value;
    }
  }
  for (const [field, label] of [["startsAt", "Start date"], ["endsAt", "End date"]]) {
    if (body[field] === undefined) continue;
    if (body[field] === null || body[field] === "") data[field] = null;
    else {
      const value = new Date(body[field]);
      if (Number.isNaN(value.getTime())) errors.push(`${label} is invalid`);
      else data[field] = value;
    }
  }
  if (body.usageLimit !== undefined) {
    if (body.usageLimit === null || body.usageLimit === "") data.usageLimit = null;
    else {
      const usageLimit = Number(body.usageLimit);
      if (!Number.isInteger(usageLimit) || usageLimit <= 0) errors.push("Usage limit must be a positive whole number");
      else data.usageLimit = usageLimit;
    }
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") errors.push("isActive must be true or false");
    else data.isActive = body.isActive;
  }
  const type = data.type || String(body.existingType || "");
  if (type === "PERCENTAGE" && data.value !== undefined && Number(data.value) > 100) {
    errors.push("Percentage discount cannot exceed 100");
  }
  if (data.startsAt && data.endsAt && data.endsAt <= data.startsAt) {
    errors.push("Discount end date must be after its start date");
  }
  return { data, errors };
}

async function listDiscounts(req, res) {
  const active = req.query.active;
  const discounts = await prisma.discount.findMany({
    where: active === "all" ? {} : { isActive: active === "false" ? false : true },
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    take: 200,
  });
  return res.json({ success: true, data: { discounts } });
}

async function createDiscount(req, res) {
  const { data, errors } = normalizeDiscount(req.body);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
  try {
    const discount = await prisma.$transaction(async (transaction) => {
      const created = await transaction.discount.create({ data });
      await transaction.auditLog.create({
        data: { userId: req.user.id, action: "CREATE_DISCOUNT", entityType: "DISCOUNT", entityId: created.id, details: { code: created.code, type: created.type } },
      });
      return created;
    });
    return res.status(201).json({ success: true, message: "Discount created", data: { discount } });
  } catch (error) {
    if (error.code === "P2002") return res.status(409).json({ success: false, message: "That discount code already exists" });
    throw error;
  }
}

async function updateDiscount(req, res) {
  const discountId = Number(req.params.id);
  if (!Number.isInteger(discountId) || discountId <= 0) return res.status(400).json({ success: false, message: "Invalid discount ID" });
  const existing = await prisma.discount.findUnique({ where: { id: discountId } });
  if (!existing) return res.status(404).json({ success: false, message: "Discount not found" });
  const { data, errors } = normalizeDiscount({ ...req.body, existingType: existing.type }, true);
  const nextType = data.type || existing.type;
  const nextValue = data.value ?? existing.value.toFixed(2);
  if (nextType === "PERCENTAGE" && Number(nextValue) > 100) errors.push("Percentage discount cannot exceed 100");
  const nextStart = data.startsAt === undefined ? existing.startsAt : data.startsAt;
  const nextEnd = data.endsAt === undefined ? existing.endsAt : data.endsAt;
  if (nextStart && nextEnd && nextEnd <= nextStart) errors.push("Discount end date must be after its start date");
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
  if (!Object.keys(data).length) return res.status(400).json({ success: false, message: "Provide at least one discount field to update" });
  try {
    const discount = await prisma.$transaction(async (transaction) => {
      const updated = await transaction.discount.update({ where: { id: discountId }, data });
      await transaction.auditLog.create({
        data: { userId: req.user.id, action: "UPDATE_DISCOUNT", entityType: "DISCOUNT", entityId: discountId, details: { fields: Object.keys(data) } },
      });
      return updated;
    });
    return res.json({ success: true, message: "Discount updated", data: { discount } });
  } catch (error) {
    if (error.code === "P2002") return res.status(409).json({ success: false, message: "That discount code already exists" });
    throw error;
  }
}

async function applyDiscount(req, res) {
  const discountId = Number(req.params.id);
  if (!Number.isInteger(discountId) || discountId <= 0) return res.status(400).json({ success: false, message: "Invalid discount ID" });
  const subtotalCents = moneyToCents(req.body.subtotal);
  if (subtotalCents === null || subtotalCents <= 0n) {
    return res.status(400).json({ success: false, message: "Subtotal must be greater than zero" });
  }
  const discount = await prisma.discount.findUnique({ where: { id: discountId } });
  if (!discount) return res.status(404).json({ success: false, message: "Discount not found" });
  const discountCents = calculateDiscountCents(discount, subtotalCents);
  return res.json({
    success: true,
    message: "Discount is valid",
    data: {
      discount,
      subtotal: centsToMoney(subtotalCents),
      discountAmount: centsToMoney(discountCents),
      total: centsToMoney(subtotalCents - discountCents),
    },
  });
}

module.exports = {
  listDiscounts,
  createDiscount,
  updateDiscount,
  applyDiscount,
  normalizeDiscount,
};
