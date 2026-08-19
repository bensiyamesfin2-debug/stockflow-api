const prisma = require("../config/prisma");
const ExcelJS = require("exceljs");
const {
  normalizeMoney,
  normalizeOptionalText,
} = require("../utils/validation");
const {
  normalizeProductName,
  makeInternalSku,
} = require("../utils/productCatalog");
const { cellText, normalizeImportHeader } = require("../utils/excelCells");

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


const IMPORT_HEADERS = {
  name: ["product name", "product", "name", "item name"],
  length: ["length", "length cm", "length centimetres", "length centimeters"],
  width: ["width", "width cm", "width centimetres", "width centimeters"],
  thickness: ["thickness", "thickness cm", "thickness centimetres", "thickness centimeters"],
  measurement: ["measurement", "measurement l w t", "size"],
  category: ["category", "category name"],
  sellingPrice: ["selling price", "selling price etb", "price", "sale price"],
  costPrice: ["cost price", "cost price etb", "cost", "unit cost"],
  reorderLevel: ["reorder level", "reorder", "minimum stock"],
  quantity: ["quantity to add", "opening quantity", "opening stock", "quantity", "stock quantity"],
  description: ["description", "notes"],
  isActive: ["active", "is active", "status"],
};

function findImportColumn(headerMap, field) {
  return IMPORT_HEADERS[field].map((alias) => headerMap.get(alias)).find(Boolean);
}

function parseImportBoolean(value, rowNumber, errors) {
  const normalized = String(value || "yes").trim().toLowerCase();
  if (["yes", "y", "true", "1", "active"].includes(normalized)) return true;
  if (["no", "n", "false", "0", "inactive"].includes(normalized)) return false;
  errors.push(`Row ${rowNumber}: Active must be Yes or No`);
  return true;
}

async function parseProductWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    return { rows: [], errors: ["The file is not a readable .xlsx workbook"] };
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return { rows: [], errors: ["The workbook does not contain a worksheet"] };

  const headerMap = new Map();
  worksheet.getRow(1).eachCell((cell, column) => headerMap.set(normalizeImportHeader(cellText(cell)), column));
  const columns = Object.fromEntries(Object.keys(IMPORT_HEADERS).map((field) => [field, findImportColumn(headerMap, field)]));
  const errors = [];
  if (!columns.name) errors.push("The first row needs a Product Name column");
  if ((!columns.length || !columns.width || !columns.thickness) && !columns.measurement) {
    errors.push("Add Length, Width, and Thickness columns, or one Measurement column");
  }
  if (errors.length) return { rows: [], errors };

  const rows = [];
  const seenSkus = new Map();
  const lastRow = Math.min(worksheet.actualRowCount, 2001);
  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const name = cellText(row.getCell(columns.name));
    const measurementText = columns.measurement ? cellText(row.getCell(columns.measurement)) : "";
    const rawValues = [name, measurementText, columns.length && cellText(row.getCell(columns.length)), columns.width && cellText(row.getCell(columns.width)), columns.thickness && cellText(row.getCell(columns.thickness))];
    if (rawValues.every((value) => !value)) continue;

    let length = columns.length ? cellText(row.getCell(columns.length)) : "";
    let width = columns.width ? cellText(row.getCell(columns.width)) : "";
    let thickness = columns.thickness ? cellText(row.getCell(columns.thickness)) : "";
    if (measurementText) {
      const parts = measurementText.toLowerCase().replace(/\s/g, "").split(/[x×*]/);
      if (parts.length === 3) [length, width, thickness] = parts;
      else errors.push(`Row ${rowNumber}: Measurement must look like 220 x 34 x 3`);
    }
    const category = columns.category ? cellText(row.getCell(columns.category)).replace(/\s+/g, " ") : "";
    const quantityText = columns.quantity ? cellText(row.getCell(columns.quantity)) : "0";
    const quantityToAdd = Number(quantityText || 0);
    if (!Number.isInteger(quantityToAdd) || quantityToAdd < 0 || quantityToAdd > 10_000_000) {
      errors.push(`Row ${rowNumber}: Quantity to Add must be a whole number from 0 to 10,000,000`);
    }
    const input = {
      name,
      length,
      width,
      thickness,
      sellingPrice: columns.sellingPrice ? cellText(row.getCell(columns.sellingPrice)) || "0" : "0",
      costPrice: columns.costPrice ? cellText(row.getCell(columns.costPrice)) : "",
      reorderLevel: columns.reorderLevel ? cellText(row.getCell(columns.reorderLevel)) || "5" : "5",
      description: columns.description ? cellText(row.getCell(columns.description)) : "",
      isActive: parseImportBoolean(columns.isActive ? cellText(row.getCell(columns.isActive)) : "yes", rowNumber, errors),
    };
    const validated = validateProductInput(input);
    errors.push(...validated.errors.map((error) => `Row ${rowNumber}: ${error}`));
    if (category.length > 120) errors.push(`Row ${rowNumber}: Category cannot exceed 120 characters`);
    if (category && category.length < 2) errors.push(`Row ${rowNumber}: Category must be at least 2 characters`);
    if (validated.errors.length || !Number.isInteger(quantityToAdd) || quantityToAdd < 0 || quantityToAdd > 10_000_000 || (category && (category.length < 2 || category.length > 120))) continue;

    const sku = makeInternalSku(validated.data.name, validated.data.length, validated.data.width, validated.data.thickness);
    if (seenSkus.has(sku)) {
      errors.push(`Row ${rowNumber}: duplicates row ${seenSkus.get(sku)} (${validated.data.name} ${measurementKey(validated.data.length, validated.data.width, validated.data.thickness)})`);
      continue;
    }
    seenSkus.set(sku, rowNumber);
    rows.push({ rowNumber, sku, category: category || null, data: validated.data, reorderLevel: validated.reorderLevel, quantityToAdd });
  }
  if (worksheet.actualRowCount > 2001) errors.push("The workbook exceeds the 2,000 product row limit");
  if (!rows.length && !errors.length) errors.push("The workbook does not contain any product rows");
  return { rows, errors };
}

function productIdentityKey(name, length, width, thickness) {
  return `${name}||${length}||${width}||${thickness}`;
}

async function productImportPlan(buffer, role) {
  const parsed = await parseProductWorkbook(buffer);
  if (parsed.errors.length) return { ...parsed, creates: 0, updates: 0, categoriesToCreate: [] };
  // Matching on name + dimensions (not the derived SKU) so a product survives even if the
  // SKU algorithm changed (e.g. a name was later added to CORE_PRODUCT_FAMILIES) since it was created.
  const [existingProducts, existingCategories] = await Promise.all([
    prisma.product.findMany({
      where: { OR: parsed.rows.map((row) => ({ name: row.data.name, length: row.data.length, width: row.data.width, thickness: row.data.thickness })) },
      select: { sku: true, name: true, length: true, width: true, thickness: true },
    }),
    prisma.category.findMany({ select: { name: true } }),
  ]);
  const existingByIdentity = new Set(existingProducts.map((product) => productIdentityKey(product.name, product.length, product.width, product.thickness)));
  const categoryNames = new Set(existingCategories.map((category) => category.name.toLowerCase()));
  const categoriesToCreate = [...new Set(parsed.rows.map((row) => row.category).filter(Boolean))].filter((name) => !categoryNames.has(name.toLowerCase()));
  const rowExists = (row) => existingByIdentity.has(productIdentityKey(row.data.name, row.data.length, row.data.width, row.data.thickness));
  return {
    ...parsed,
    rows: parsed.rows.map((row) => ({
      rowNumber: row.rowNumber,
      sku: row.sku,
      name: row.data.name,
      measurement: measurementKey(row.data.length, row.data.width, row.data.thickness),
      category: row.category,
      sellingPrice: row.data.sellingPrice,
      quantityToAdd: row.quantityToAdd,
      action: rowExists(row) ? "UPDATE" : "CREATE",
    })),
    creates: parsed.rows.filter((row) => !rowExists(row)).length,
    updates: parsed.rows.filter((row) => rowExists(row)).length,
    unitsToAdd: parsed.rows.reduce((sum, row) => sum + row.quantityToAdd, 0),
    categoriesToCreate,
    parsedRows: parsed.rows,
  };
}

async function previewProductImport(req, res) {
  const plan = await productImportPlan(req.body, req.user.role);
  return res.status(plan.errors.length ? 400 : 200).json({
    success: plan.errors.length === 0,
    message: plan.errors.length ? "Fix the workbook errors before importing" : "Workbook validated and ready to import",
    errors: plan.errors,
    data: { preview: { rows: plan.rows, creates: plan.creates, updates: plan.updates, unitsToAdd: plan.unitsToAdd, categoriesToCreate: plan.categoriesToCreate } },
  });
}

async function importProducts(req, res) {
  const plan = await productImportPlan(req.body, req.user.role);
  if (plan.errors.length) return res.status(400).json({ success: false, message: "Fix the workbook errors before importing", errors: plan.errors });
  const counts = await prisma.$transaction(async (transaction) => {
    const categoryRows = await transaction.category.findMany();
    const categoryByName = new Map(categoryRows.map((category) => [category.name.toLowerCase(), category]));
    for (const name of plan.categoriesToCreate) {
      const created = await transaction.category.create({ data: { name } });
      categoryByName.set(name.toLowerCase(), created);
    }
    for (const category of categoryRows.filter((entry) => !entry.isActive && plan.parsedRows.some((row) => row.category?.toLowerCase() === entry.name.toLowerCase()))) {
      const restored = await transaction.category.update({ where: { id: category.id }, data: { isActive: true } });
      categoryByName.set(restored.name.toLowerCase(), restored);
    }
    for (const row of plan.parsedRows) {
      // Match the existing product by name + dimensions rather than the derived SKU: the SKU
      // algorithm can change over time (e.g. a name joining CORE_PRODUCT_FAMILIES), which would
      // otherwise make re-importing the same product create a duplicate instead of restocking it.
      const existing = await transaction.product.findFirst({
        where: { name: row.data.name, length: row.data.length, width: row.data.width, thickness: row.data.thickness },
        orderBy: { id: "asc" },
      });
      const productData = {
        ...row.data,
        sku: row.sku,
        sellingPrice: row.data.sellingPrice,
        categoryId: row.category ? categoryByName.get(row.category.toLowerCase()).id : null,
      };
      if (existing && existing.sku !== row.sku) {
        const skuOwner = await transaction.product.findUnique({ where: { sku: row.sku }, select: { id: true } });
        if (skuOwner && skuOwner.id !== existing.id) delete productData.sku;
      }
      const product = existing
        ? await transaction.product.update({ where: { id: existing.id }, data: productData })
        : await transaction.product.create({ data: productData });
      const inventory = await transaction.inventory.upsert({
        where: { productId: product.id },
        create: { productId: product.id, quantity: row.quantityToAdd, reservedQuantity: 0, reorderLevel: row.reorderLevel },
        update: { reorderLevel: row.reorderLevel, ...(row.quantityToAdd > 0 ? { quantity: { increment: row.quantityToAdd } } : {}) },
      });
      if (row.quantityToAdd > 0) {
        await transaction.inventoryMovement.create({ data: {
          productId: product.id, movementType: "STOCK_IN", quantityChange: row.quantityToAdd,
          balanceAfter: inventory.quantity, referenceType: "EXCEL_PRODUCT_IMPORT",
          createdById: req.user.id, notes: `Opening stock added from Excel row ${row.rowNumber}`,
        } });
      }
    }
    const result = { created: plan.creates, updated: plan.updates, unitsAdded: plan.unitsToAdd, categoriesCreated: plan.categoriesToCreate.length, total: plan.parsedRows.length };
    await transaction.auditLog.create({ data: { userId: req.user.id, action: "IMPORT_PRODUCT_CATALOGUE", entityType: "PRODUCT", details: result } });
    return result;
  }, { timeout: 30000 });
  return res.status(201).json({ success: true, message: `${counts.total} products imported from Excel`, data: { counts } });
}

async function downloadProductImportTemplate(req, res) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "StockFlow";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Products", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    { header: "Product Name", key: "name", width: 24 }, { header: "Length (cm)", key: "length", width: 14 },
    { header: "Width (cm)", key: "width", width: 14 }, { header: "Thickness (cm)", key: "thickness", width: 16 },
    { header: "Category", key: "category", width: 20 }, { header: "Selling Price (ETB)", key: "sellingPrice", width: 19 },
    { header: "Cost Price (ETB)", key: "costPrice", width: 17 }, { header: "Reorder Level", key: "reorderLevel", width: 15 },
    { header: "Quantity to Add", key: "quantity", width: 17 }, { header: "Description", key: "description", width: 34 },
    { header: "Active", key: "active", width: 12 },
  ];
  sheet.addRow({ name: "603", length: 220, width: 34, thickness: 3, category: "Granite", sellingPrice: 0, costPrice: 0, reorderLevel: 5, quantity: 24, description: "Replace this example with a real product", active: "Yes" });
  sheet.getRow(1).eachCell((cell) => { cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111111" } }; cell.alignment = { vertical: "middle" }; });
  sheet.getRow(1).height = 26;
  sheet.autoFilter = { from: "A1", to: "K2" };
  sheet.getColumn(6).numFmt = '#,##0.00 "ETB"';
  sheet.getColumn(7).numFmt = '#,##0.00 "ETB"';
  sheet.getColumn(9).numFmt = "0";
  sheet.getColumn(11).eachCell({ includeEmpty: true }, (cell, rowNumber) => { if (rowNumber > 1) cell.dataValidation = { type: "list", allowBlank: true, formulae: ['"Yes,No"'] }; });
  const instructions = workbook.addWorksheet("Instructions");
  instructions.columns = [{ width: 110 }];
  ["STOCKFLOW PRODUCT IMPORT", "Keep the header row unchanged. Add one product measurement per row.", "Length, width, and thickness must match an approved StockFlow measurement.", "Quantity to Add is optional. Enter a whole number to add that stock to the current balance; use 0 or leave it blank to make no stock change.", "Existing products with the same name and measurement are updated. Re-importing a positive quantity adds it again, so always preview before confirming.", "Categories that do not yet exist are created automatically."].forEach((text) => instructions.addRow([text]));
  instructions.getCell("A1").font = { bold: true, size: 16 };
  instructions.getColumn(1).alignment = { wrapText: true, vertical: "top" };
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="stockflow-product-import-template.xlsx"');
  return res.send(Buffer.from(buffer));
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

  // Match by name + dimensions, not the derived SKU: the SKU algorithm can change over time
  // (e.g. a name joining CORE_PRODUCT_FAMILIES), which would otherwise let the same product get
  // re-created as a duplicate instead of being recognised.
  const existingProduct = await prisma.product.findFirst({
    where: { name: data.name, length: data.length, width: data.width, thickness: data.thickness },
    orderBy: { id: "asc" },
  });

  if (existingProduct?.isActive) {
    return res.status(409).json({
      success: false,
      message: "That product and measurement already exist",
    });
  }
  if (existingProduct && existingProduct.sku !== data.sku) {
    const skuOwner = await prisma.product.findUnique({ where: { sku: data.sku }, select: { id: true } });
    if (skuOwner && skuOwner.id !== existingProduct.id) delete data.sku;
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
  previewProductImport,
  importProducts,
  downloadProductImportTemplate,
  parseProductWorkbook,
  productImportPlan,
  validateProductInput,
};
