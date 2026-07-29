const prisma = require("../config/prisma");
const {
  normalizeMoney,
  normalizeOptionalText,
} = require("../utils/validation");
const {
  normalizeProductName,
  makeInternalSku,
} = require("../utils/productCatalog");

const ALLOWED_MEASUREMENTS = new Set([
  "220x34x3", "200x34x3", "180x34x3", "160x34x3", "150x34x3",
  "140x34x3", "130x34x3", "125x34x3", "120x34x3", "115x34x3",
  "220x30x3", "200x30x3", "180x30x3", "160x30x3", "150x30x3",
  "140x30x3", "125x30x3",
  "220x28x3", "200x28x3", "180x28x3", "160x28x3", "150x28x3",
  "140x28x3", "125x28x3",
  "220x25x3", "200x25x3", "180x25x3", "160x25x3", "150x25x3",
  "140x25x3", "125x25x3",
  "240x63x2", "220x63x2",
  "220x50x2", "200x50x2", "180x50x2", "160x50x2", "150x50x2",
  "140x50x2", "125x50x2",
  "220x40x2", "200x40x2", "180x40x2", "160x40x2", "150x40x2",
  "140x40x2", "125x40x2",
  "220x30x2", "200x30x2", "180x30x2", "160x30x2", "150x30x2",
  "125x30x2",
  "200x25x2", "180x25x2", "160x25x2", "150x25x2", "140x25x2",
  "125x25x2",
  "200x20x2", "180x20x2", "160x20x2", "150x20x2", "140x20x2",
  "125x20x2",
  "40x40x1",
]);

function measurementKey(length, width, thickness) {
  return `${length}x${width}x${thickness}`;
}

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
    measurement:
      product.length && product.width && product.thickness
        ? `${product.length} × ${product.width} × ${product.thickness}`
        : null,
    inventory,
    lowStock: inventory
      ? inventory.availableQuantity <= inventory.reorderLevel
      : true,
  };
}

function validateProductInput(body, partial = false) {
  const data = {};
  const errors = [];

  if (!partial || body.name !== undefined) {
    const normalizedName = normalizeProductName(body.name);
    if (normalizedName.error) {
      errors.push(normalizedName.error);
    } else {
      data.name = normalizedName.name;
    }
  }

  for (const field of ["length", "width", "thickness"]) {
    if (!partial || body[field] !== undefined) {
      const value = Number(body[field]);
      if (!Number.isInteger(value) || value <= 0) {
        errors.push(`${field[0].toUpperCase()}${field.slice(1)} must be a positive whole number`);
      } else {
        data[field] = value;
      }
    }
  }

  if (
    data.length !== undefined &&
    data.width !== undefined &&
    data.thickness !== undefined &&
    !ALLOWED_MEASUREMENTS.has(
      measurementKey(data.length, data.width, data.thickness)
    )
  ) {
    errors.push("Choose a measurement from the approved measurement sheet");
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

  if (body.categoryId !== undefined) {
    if (body.categoryId === null || body.categoryId === "") {
      data.categoryId = null;
    } else {
      const categoryId = Number(body.categoryId);
      if (!Number.isInteger(categoryId) || categoryId <= 0) {
        errors.push("Category ID is invalid");
      } else {
        data.categoryId = categoryId;
      }
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

  if (req.user.role === "INVENTORY_STAFF") {
    data.sellingPrice = "0";
  }

  if (data.categoryId !== undefined && data.categoryId !== null) {
    const category = await prisma.category.findUnique({ where: { id: data.categoryId } });
    if (!category || !category.isActive) {
      return res.status(400).json({ success: false, message: "Category does not exist or is inactive" });
    }
  }

  data.sku = makeInternalSku(
    data.name,
    data.length,
    data.width,
    data.thickness
  );

  const existingProduct = await prisma.product.findUnique({
    where: { sku: data.sku },
  });

  if (existingProduct?.isActive) {
    return res.status(409).json({
      success: false,
      message: "That product and measurement already exist",
    });
  }
  if (req.user.role === "INVENTORY_STAFF" && existingProduct) {
    delete data.sellingPrice;
  }

  try {
    const product = await prisma.$transaction(async (transaction) => {
      const createdProduct = existingProduct
        ? await transaction.product.update({
            where: { id: existingProduct.id },
            data: { ...data, isActive: true },
            include: { inventory: true, category: true },
          })
        : await transaction.product.create({
            data: {
              ...data,
              inventory: { create: { quantity: 0, reorderLevel } },
            },
            include: { inventory: true, category: true },
          });

      if (existingProduct) {
        await transaction.inventory.upsert({
          where: { productId: existingProduct.id },
          update: { reorderLevel },
          create: {
            productId: existingProduct.id,
            quantity: 0,
            reorderLevel,
          },
        });
      }

      await transaction.auditLog.create({
        data: {
          userId: req.user.id,
          action: existingProduct ? "RESTORE_PRODUCT" : "CREATE_PRODUCT",
          entityType: "PRODUCT",
          entityId: createdProduct.id,
          details: {
            product: createdProduct.name,
            measurement: measurementKey(
              createdProduct.length,
              createdProduct.width,
              createdProduct.thickness
            ),
          },
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
        message: "That product and measurement already exist",
      });
    }

    throw error;
  }
}

async function listProducts(req, res) {
  const search = String(req.query.search || "").trim();
  const where = {};

  if (req.query.active === "all" && req.user.role === "ADMIN") {
    // Administrators can explicitly request the retired catalogue for audits.
  } else if (req.query.active === "true" || req.query.active === "false") {
    where.isActive = req.query.active === "true";
  } else {
    where.isActive = true;
  }

  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { sku: { contains: search, mode: "insensitive" } },
    ];
  }

  const products = await prisma.product.findMany({
    where,
    include: { inventory: true, category: true },
    orderBy: [
      { name: "asc" },
      { thickness: "desc" },
      { width: "desc" },
      { length: "desc" },
    ],
  });

  return res.json({
    success: true,
    data: { products: products.map(serializeProduct) },
  });
}

async function getProduct(req, res) {
  const productId = Number(req.params.id);

  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).json({ success: false, message: "Invalid product ID" });
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { inventory: true, category: true },
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

  if (!Number.isInteger(productId) || productId <= 0) {
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

  if (data.categoryId !== undefined && data.categoryId !== null) {
    const category = await prisma.category.findUnique({ where: { id: data.categoryId } });
    if (!category || !category.isActive) {
      return res.status(400).json({ success: false, message: "Category does not exist or is inactive" });
    }
  }

  const nextName = data.name ?? existingProduct.name;
  const nextLength = data.length ?? existingProduct.length;
  const nextWidth = data.width ?? existingProduct.width;
  const nextThickness = data.thickness ?? existingProduct.thickness;

  if (
    !ALLOWED_MEASUREMENTS.has(
      measurementKey(nextLength, nextWidth, nextThickness)
    )
  ) {
    return res.status(400).json({
      success: false,
      message: "Choose a measurement from the approved measurement sheet",
    });
  }

  if (
    data.name !== undefined ||
    data.length !== undefined ||
    data.width !== undefined ||
    data.thickness !== undefined
  ) {
    data.sku = makeInternalSku(
      nextName,
      nextLength,
      nextWidth,
      nextThickness
    );
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
        include: { inventory: true, category: true },
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
        message: "That product and measurement already exist",
      });
    }

    throw error;
  }
}

async function deleteProduct(req, res) {
  const productId = Number(req.params.id);

  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).json({ success: false, message: "Invalid product ID" });
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { inventory: true },
  });

  if (!product) {
    return res.status(404).json({ success: false, message: "Product not found" });
  }

  if ((product.inventory?.reservedQuantity || 0) > 0) {
    return res.status(409).json({
      success: false,
      message: "This product is reserved on an open order and cannot be deleted",
    });
  }

  await prisma.$transaction(async (transaction) => {
    await transaction.product.update({
      where: { id: productId },
      data: { isActive: false },
    });
    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "DELETE_PRODUCT",
        entityType: "PRODUCT",
        entityId: productId,
        details: {
          product: product.name,
          measurement: measurementKey(
            product.length,
            product.width,
            product.thickness
          ),
        },
      },
    });
  });

  return res.json({
    success: true,
    message: "Product removed from the active catalogue",
  });
}

module.exports = {
  createProduct,
  listProducts,
  getProduct,
  updateProduct,
  deleteProduct,
};
