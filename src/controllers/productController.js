const prisma = require("../config/prisma");
const {
  normalizeMoney,
  normalizeOptionalText,
} = require("../utils/validation");

const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{1,99}$/;

function serializeProduct(product) {
  const inventory = product.inventory
    ? {
        ...product.inventory,
        availableQuantity:
          product.inventory.quantity - product.inventory.reservedQuantity,
      }
    : null;

  return {
    ...product,
    inventory,
    lowStock: inventory
      ? inventory.availableQuantity <= inventory.reorderLevel
      : true,
  };
}

function validateProductInput(body, partial = false) {
  const data = {};
  const errors = [];

  if (!partial || body.sku !== undefined) {
    const sku = String(body.sku || "").trim().toUpperCase();
    if (!SKU_PATTERN.test(sku)) {
      errors.push(
        "SKU must be 2-100 characters using letters, numbers, dots, underscores, slashes, or hyphens"
      );
    } else {
      data.sku = sku;
    }
  }

  if (!partial || body.name !== undefined) {
    const name = String(body.name || "").trim();
    if (name.length < 2 || name.length > 200) {
      errors.push("Product name must be between 2 and 200 characters");
    } else {
      data.name = name;
    }
  }

  if (body.description !== undefined) {
    if (body.description === null || body.description === "") {
      data.description = null;
    } else {
      const description = normalizeOptionalText(body.description, 2000);
      if (!description) {
        errors.push("Description cannot exceed 2,000 characters");
      } else {
        data.description = description;
      }
    }
  }

  if (!partial || body.sellingPrice !== undefined) {
    const sellingPrice = normalizeMoney(body.sellingPrice);
    if (sellingPrice === null) {
      errors.push("Selling price must be a non-negative amount with at most 2 decimal places");
    } else {
      data.sellingPrice = sellingPrice;
    }
  }

  if (body.costPrice !== undefined) {
    if (body.costPrice === null || body.costPrice === "") {
      data.costPrice = null;
    } else {
      const costPrice = normalizeMoney(body.costPrice);
      if (costPrice === null) {
        errors.push("Cost price must be a non-negative amount with at most 2 decimal places");
      } else {
        data.costPrice = costPrice;
      }
    }
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      errors.push("isActive must be true or false");
    } else {
      data.isActive = body.isActive;
    }
  }

  let reorderLevel;
  if (!partial || body.reorderLevel !== undefined) {
    reorderLevel = Number(body.reorderLevel ?? 5);
    if (!Number.isInteger(reorderLevel) || reorderLevel < 0) {
      errors.push("Reorder level must be a non-negative whole number");
    }
  }

  return { data, reorderLevel, errors };
}

async function createProduct(req, res) {
  const { data, reorderLevel, errors } = validateProductInput(req.body);

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors[0], errors });
  }

  const existingProduct = await prisma.product.findUnique({
    where: { sku: data.sku },
  });

  if (existingProduct) {
    return res.status(409).json({
      success: false,
      message: "A product with that SKU already exists",
    });
  }

  try {
    const product = await prisma.$transaction(async (transaction) => {
      const createdProduct = await transaction.product.create({
        data: {
          ...data,
          inventory: { create: { quantity: 0, reorderLevel } },
        },
        include: { inventory: true },
      });

      await transaction.auditLog.create({
        data: {
          userId: req.user.id,
          action: "CREATE_PRODUCT",
          entityType: "PRODUCT",
          entityId: createdProduct.id,
          details: { sku: createdProduct.sku },
        },
      });

      return createdProduct;
    });

    return res.status(201).json({
      success: true,
      message: "Product created successfully",
      data: { product: serializeProduct(product) },
    });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({
        success: false,
        message: "A product with that SKU already exists",
      });
    }

    throw error;
  }
}

async function listProducts(req, res) {
  const search = String(req.query.search || "").trim();
  const where = {};

  if (req.user.role !== "ADMIN") {
    where.isActive = true;
  } else if (req.query.active === "true" || req.query.active === "false") {
    where.isActive = req.query.active === "true";
  }

  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { sku: { contains: search, mode: "insensitive" } },
    ];
  }

  const products = await prisma.product.findMany({
    where,
    include: { inventory: true },
    orderBy: { name: "asc" },
  });

  return res.json({
    success: true,
    data: { products: products.map(serializeProduct) },
  });
}

async function getProduct(req, res) {
  const productId = Number(req.params.id);

  if (!Number.isInteger(productId)) {
    return res.status(400).json({ success: false, message: "Invalid product ID" });
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { inventory: true },
  });

  if (!product || (req.user.role !== "ADMIN" && !product.isActive)) {
    return res.status(404).json({ success: false, message: "Product not found" });
  }

  return res.json({
    success: true,
    data: { product: serializeProduct(product) },
  });
}

async function updateProduct(req, res) {
  const productId = Number(req.params.id);

  if (!Number.isInteger(productId)) {
    return res.status(400).json({ success: false, message: "Invalid product ID" });
  }

  const { data, reorderLevel, errors } = validateProductInput(req.body, true);

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors[0], errors });
  }

  if (Object.keys(data).length === 0 && reorderLevel === undefined) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one product field to update",
    });
  }

  const existingProduct = await prisma.product.findUnique({
    where: { id: productId },
  });

  if (!existingProduct) {
    return res.status(404).json({ success: false, message: "Product not found" });
  }

  try {
    const product = await prisma.$transaction(async (transaction) => {
      await transaction.product.update({ where: { id: productId }, data });

      if (reorderLevel !== undefined) {
        await transaction.inventory.upsert({
          where: { productId },
          update: { reorderLevel },
          create: { productId, reorderLevel, quantity: 0 },
        });
      }

      await transaction.auditLog.create({
        data: {
          userId: req.user.id,
          action: "UPDATE_PRODUCT",
          entityType: "PRODUCT",
          entityId: productId,
          details: {
            fields: [
              ...Object.keys(data),
              ...(reorderLevel !== undefined ? ["reorderLevel"] : []),
            ],
          },
        },
      });

      return transaction.product.findUnique({
        where: { id: productId },
        include: { inventory: true },
      });
    });

    return res.json({
      success: true,
      message: "Product updated successfully",
      data: { product: serializeProduct(product) },
    });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({
        success: false,
        message: "A product with that SKU already exists",
      });
    }

    throw error;
  }
}

module.exports = {
  createProduct,
  listProducts,
  getProduct,
  updateProduct,
};
