const prisma = require("../config/prisma");
const { normalizeOptionalText } = require("../utils/validation");

function normalizeCategory(body, partial = false) {
  const data = {};
  const errors = [];

  if (!partial || body.name !== undefined) {
    const name = String(body.name || "").trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 120) {
      errors.push("Category name must be between 2 and 120 characters");
    } else {
      data.name = name;
    }
  }

  if (body.description !== undefined) {
    if (body.description === null || body.description === "") {
      data.description = null;
    } else {
      const description = normalizeOptionalText(body.description, 1000);
      if (!description) errors.push("Description cannot exceed 1,000 characters");
      else data.description = description;
    }
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") errors.push("isActive must be true or false");
    else data.isActive = body.isActive;
  }

  return { data, errors };
}

async function listCategories(req, res) {
  const where = req.query.active === "all"
    ? {}
    : { isActive: req.query.active === "false" ? false : true };
  const categories = await prisma.category.findMany({
    where,
    include: { _count: { select: { products: true } } },
    orderBy: { name: "asc" },
  });
  return res.json({ success: true, data: { categories } });
}

async function createCategory(req, res) {
  const { data, errors } = normalizeCategory(req.body);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

  try {
    const category = await prisma.$transaction(async (transaction) => {
      const created = await transaction.category.create({ data });
      await transaction.auditLog.create({
        data: {
          userId: req.user.id,
          action: "CREATE_CATEGORY",
          entityType: "CATEGORY",
          entityId: created.id,
          details: { name: created.name },
        },
      });
      return created;
    });
    return res.status(201).json({ success: true, message: "Category created", data: { category } });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ success: false, message: "A category with that name already exists" });
    }
    throw error;
  }
}

async function updateCategory(req, res) {
  const categoryId = Number(req.params.id);
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    return res.status(400).json({ success: false, message: "Invalid category ID" });
  }
  const { data, errors } = normalizeCategory(req.body, true);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
  if (!Object.keys(data).length) {
    return res.status(400).json({ success: false, message: "Provide at least one category field to update" });
  }

  try {
    const category = await prisma.$transaction(async (transaction) => {
      const existing = await transaction.category.findUnique({ where: { id: categoryId } });
      if (!existing) return null;
      const updated = await transaction.category.update({ where: { id: categoryId }, data });
      await transaction.auditLog.create({
        data: {
          userId: req.user.id,
          action: "UPDATE_CATEGORY",
          entityType: "CATEGORY",
          entityId: categoryId,
          details: { fields: Object.keys(data) },
        },
      });
      return updated;
    });
    if (!category) return res.status(404).json({ success: false, message: "Category not found" });
    return res.json({ success: true, message: "Category updated", data: { category } });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ success: false, message: "A category with that name already exists" });
    }
    throw error;
  }
}

module.exports = { listCategories, createCategory, updateCategory, normalizeCategory };
