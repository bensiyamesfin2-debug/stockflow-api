const prisma = require("../config/prisma");
const HttpError = require("../utils/HttpError");

const SUPPORTED_CURRENCIES = new Set(["ETB", "USD", "EUR", "KES", "AED", "SAR"]);
const SUPPORTED_LANGUAGES = new Set(["en", "am", "om"]);
const SUPPORTED_THEMES = new Set(["system", "light", "dark"]);
const NOTE_COLORS = new Set(["yellow", "teal", "violet", "orange", "rose"]);
const MAX_ATTACHMENT_BYTES = 350_000;

function text(value, maximumLength) {
  const normalized = String(value ?? "").trim();
  return normalized && normalized.length <= maximumLength ? normalized : null;
}

function optionalText(value, maximumLength) {
  if (value === undefined || value === null || value === "") return null;
  return text(value, maximumLength);
}

function date(value, label) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new HttpError(400, `Valid ${label} is required`);
  return parsed;
}

function serializeSettings(settings) {
  return {
    companyName: settings.companyName,
    companyCode: settings.companyCode,
    primaryCurrency: settings.primaryCurrency,
    locale: settings.locale,
    timezone: settings.timezone,
    invoiceEmail: settings.invoiceEmail,
    invoicePhone: settings.invoicePhone,
    updatedAt: settings.updatedAt,
  };
}

function serializeAttachment(attachment, includeContent = false) {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    resourceType: attachment.resourceType,
    resourceId: attachment.resourceId,
    createdAt: attachment.createdAt,
    uploadedBy: attachment.uploadedBy
      ? { id: attachment.uploadedBy.id, fullName: attachment.uploadedBy.fullName }
      : undefined,
    ...(includeContent ? { content: attachment.content } : {}),
  };
}

async function getSettingsRecord() {
  const existing = await prisma.workspaceSettings.findFirst({ orderBy: { id: "asc" } });
  if (existing) return existing;
  return prisma.workspaceSettings.create({
    data: { companyName: "StockFlow workspace", primaryCurrency: "ETB", locale: "en" },
  });
}

async function getWorkspace(req, res) {
  const [settings, preferences, notes, events, favorites, templates] = await Promise.all([
    getSettingsRecord(),
    prisma.userPreference.findUnique({ where: { userId: req.user.id } }),
    prisma.workspaceNote.findMany({
      where: { userId: req.user.id },
      take: 8,
      orderBy: [{ isPinned: "desc" }, { updatedAt: "desc" }],
    }),
    prisma.calendarEvent.findMany({
      where: { endsAt: { gte: new Date() } },
      include: { owner: { select: { id: true, fullName: true } } },
      take: 8,
      orderBy: { startsAt: "asc" },
    }),
    prisma.favorite.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" }, take: 12 }),
    prisma.invoiceTemplate.findMany({ orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }], take: 8 }),
  ]);

  return res.json({
    success: true,
    data: {
      settings: serializeSettings(settings),
      preferences: preferences || { theme: "system", language: settings.locale, currency: settings.primaryCurrency },
      notes,
      events: events.map((event) => ({ ...event, owner: event.owner })),
      favorites,
      templates,
    },
  });
}

async function updateSettings(req, res) {
  if (req.user.role !== "ADMIN") throw new HttpError(403, "Only administrators can change workspace settings");
  const current = await getSettingsRecord();
  const companyName = text(req.body.companyName ?? current.companyName, 160);
  const primaryCurrency = String(req.body.primaryCurrency ?? current.primaryCurrency).toUpperCase();
  const locale = String(req.body.locale ?? current.locale).toLowerCase();
  const timezone = text(req.body.timezone ?? current.timezone, 64);
  const companyCode = optionalText(req.body.companyCode, 40);
  const invoiceEmail = optionalText(req.body.invoiceEmail, 254);
  const invoicePhone = optionalText(req.body.invoicePhone, 40);

  if (!companyName || !timezone || !SUPPORTED_CURRENCIES.has(primaryCurrency) || !SUPPORTED_LANGUAGES.has(locale)) {
    throw new HttpError(400, "Enter a valid company name, currency, language, and timezone");
  }

  const settings = await prisma.workspaceSettings.update({
    where: { id: current.id },
    data: { companyName, companyCode, primaryCurrency, locale, timezone, invoiceEmail, invoicePhone, updatedById: req.user.id },
  });
  await prisma.auditLog.create({ data: { userId: req.user.id, action: "UPDATE_WORKSPACE_SETTINGS", entityType: "WORKSPACE", entityId: settings.id } });
  return res.json({ success: true, data: { settings: serializeSettings(settings) } });
}

async function updatePreferences(req, res) {
  const theme = String(req.body.theme ?? "system").toLowerCase();
  const language = String(req.body.language ?? "en").toLowerCase();
  const currency = req.body.currency ? String(req.body.currency).toUpperCase() : null;
  if (!SUPPORTED_THEMES.has(theme) || !SUPPORTED_LANGUAGES.has(language) || (currency && !SUPPORTED_CURRENCIES.has(currency))) {
    throw new HttpError(400, "Unsupported display preference");
  }
  const preferences = await prisma.userPreference.upsert({
    where: { userId: req.user.id },
    create: { userId: req.user.id, theme, language, currency },
    update: { theme, language, currency },
  });
  return res.json({ success: true, data: { preferences } });
}

async function globalSearch(req, res) {
  const query = text(req.query.q, 80);
  if (!query || query.length < 2) throw new HttpError(400, "Enter at least two characters to search");
  const productWhere = { OR: [{ name: { contains: query, mode: "insensitive" } }, { sku: { contains: query, mode: "insensitive" } }, { description: { contains: query, mode: "insensitive" } }] };
  const customerWhere = { OR: [{ name: { contains: query, mode: "insensitive" } }, { phone: { contains: query, mode: "insensitive" } }, { email: { contains: query, mode: "insensitive" } }] };
  const saleWhere = {
    ...(req.user.role === "CASHIER" ? { cashierId: req.user.id } : {}),
    OR: [{ saleNumber: { contains: query, mode: "insensitive" } }, { customerName: { contains: query, mode: "insensitive" } }],
  };
  const [products, customers, sales] = await Promise.all([
    prisma.product.findMany({ where: productWhere, select: { id: true, sku: true, name: true, length: true, width: true, thickness: true, sellingPrice: true }, take: 8, orderBy: { name: "asc" } }),
    prisma.customer.findMany({ where: customerWhere, select: { id: true, name: true, phone: true, email: true }, take: 8, orderBy: { name: "asc" } }),
    prisma.sale.findMany({ where: saleWhere, select: { id: true, saleNumber: true, customerName: true, totalAmount: true, status: true, createdAt: true }, take: 8, orderBy: { createdAt: "desc" } }),
  ]);
  const results = [
    ...products.map((product) => ({ type: "PRODUCT", id: String(product.id), title: product.name, subtitle: `${product.sku} · ${product.length || "—"} × ${product.width || "—"} × ${product.thickness || "—"}`, value: String(product.sellingPrice) })),
    ...customers.map((customer) => ({ type: "CUSTOMER", id: String(customer.id), title: customer.name, subtitle: customer.phone || customer.email || "Customer", value: "" })),
    ...sales.map((sale) => ({ type: "SALE", id: String(sale.id), title: sale.saleNumber, subtitle: sale.customerName || "Walk-in customer", value: String(sale.totalAmount), status: sale.status })),
  ];
  return res.json({ success: true, data: { results } });
}

async function listNotes(req, res) {
  const notes = await prisma.workspaceNote.findMany({ where: { userId: req.user.id }, orderBy: [{ isPinned: "desc" }, { updatedAt: "desc" }] });
  return res.json({ success: true, data: { notes } });
}

async function createNote(req, res) {
  const title = text(req.body.title, 140);
  const content = String(req.body.content ?? "").trim();
  const color = String(req.body.color ?? "yellow").toLowerCase();
  if (!title || content.length > 4000 || !NOTE_COLORS.has(color)) throw new HttpError(400, "Enter a note title, a shorter note, and a valid color");
  const note = await prisma.workspaceNote.create({ data: { userId: req.user.id, title, content, color, isPinned: Boolean(req.body.isPinned) } });
  return res.status(201).json({ success: true, data: { note } });
}

async function updateNote(req, res) {
  const id = Number(req.params.id);
  const note = await prisma.workspaceNote.findFirst({ where: { id, userId: req.user.id } });
  if (!note) throw new HttpError(404, "Note not found");
  const data = {};
  if (req.body.title !== undefined) { const title = text(req.body.title, 140); if (!title) throw new HttpError(400, "Enter a valid note title"); data.title = title; }
  if (req.body.content !== undefined) { const content = String(req.body.content).trim(); if (content.length > 4000) throw new HttpError(400, "Note is too long"); data.content = content; }
  if (req.body.color !== undefined) { const color = String(req.body.color).toLowerCase(); if (!NOTE_COLORS.has(color)) throw new HttpError(400, "Invalid note color"); data.color = color; }
  if (req.body.isPinned !== undefined) data.isPinned = Boolean(req.body.isPinned);
  const updated = await prisma.workspaceNote.update({ where: { id }, data });
  return res.json({ success: true, data: { note: updated } });
}

async function deleteNote(req, res) {
  const id = Number(req.params.id);
  const deleted = await prisma.workspaceNote.deleteMany({ where: { id, userId: req.user.id } });
  if (!deleted.count) throw new HttpError(404, "Note not found");
  return res.json({ success: true });
}

async function listCalendarEvents(req, res) {
  const from = req.query.from ? date(req.query.from, "start date") : new Date(new Date().setDate(new Date().getDate() - 31));
  const to = req.query.to ? date(req.query.to, "end date") : new Date(new Date().setDate(new Date().getDate() + 120));
  if (from > to) throw new HttpError(400, "Calendar end must be after start");
  const events = await prisma.calendarEvent.findMany({ where: { startsAt: { lte: to }, endsAt: { gte: from } }, include: { owner: { select: { id: true, fullName: true } } }, orderBy: { startsAt: "asc" } });
  return res.json({ success: true, data: { events } });
}

async function createCalendarEvent(req, res) {
  const title = text(req.body.title, 160);
  const startsAt = date(req.body.startsAt, "event start");
  const endsAt = date(req.body.endsAt, "event end");
  const description = optionalText(req.body.description, 2000);
  const color = text(req.body.color ?? "teal", 20);
  if (!title || !color || endsAt <= startsAt) throw new HttpError(400, "Enter a title and a valid event time range");
  const event = await prisma.calendarEvent.create({ data: { ownerId: req.user.id, title, description, startsAt, endsAt, color }, include: { owner: { select: { id: true, fullName: true } } } });
  return res.status(201).json({ success: true, data: { event } });
}

async function updateCalendarEvent(req, res) {
  const id = Number(req.params.id);
  const existing = await prisma.calendarEvent.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, "Calendar event not found");
  if (existing.ownerId !== req.user.id && req.user.role !== "ADMIN") throw new HttpError(403, "Only the owner or an administrator can edit this event");
  const startsAt = req.body.startsAt === undefined ? existing.startsAt : date(req.body.startsAt, "event start");
  const endsAt = req.body.endsAt === undefined ? existing.endsAt : date(req.body.endsAt, "event end");
  const title = req.body.title === undefined ? existing.title : text(req.body.title, 160);
  if (!title || endsAt <= startsAt) throw new HttpError(400, "Enter a title and a valid event time range");
  const event = await prisma.calendarEvent.update({ where: { id }, data: { title, startsAt, endsAt, ...(req.body.description !== undefined ? { description: optionalText(req.body.description, 2000) } : {}), ...(req.body.color !== undefined ? { color: text(req.body.color, 20) } : {}) }, include: { owner: { select: { id: true, fullName: true } } } });
  return res.json({ success: true, data: { event } });
}

async function deleteCalendarEvent(req, res) {
  const id = Number(req.params.id);
  const existing = await prisma.calendarEvent.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, "Calendar event not found");
  if (existing.ownerId !== req.user.id && req.user.role !== "ADMIN") throw new HttpError(403, "Only the owner or an administrator can delete this event");
  await prisma.calendarEvent.delete({ where: { id } });
  return res.json({ success: true });
}

async function listFavorites(req, res) {
  const favorites = await prisma.favorite.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" } });
  return res.json({ success: true, data: { favorites } });
}

async function createFavorite(req, res) {
  const resourceType = text(req.body.resourceType, 40);
  const resourceId = text(req.body.resourceId, 100);
  const label = text(req.body.label, 160);
  if (!resourceType || !resourceId || !label) throw new HttpError(400, "Choose a valid favorite");
  const favorite = await prisma.favorite.upsert({ where: { userId_resourceType_resourceId: { userId: req.user.id, resourceType, resourceId } }, create: { userId: req.user.id, resourceType, resourceId, label }, update: { label } });
  return res.status(201).json({ success: true, data: { favorite } });
}

async function deleteFavorite(req, res) {
  const id = Number(req.params.id);
  const deleted = await prisma.favorite.deleteMany({ where: { id, userId: req.user.id } });
  if (!deleted.count) throw new HttpError(404, "Favorite not found");
  return res.json({ success: true });
}

async function listTemplates(req, res) {
  const templates = await prisma.invoiceTemplate.findMany({ orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }], include: { createdBy: { select: { id: true, fullName: true } } } });
  return res.json({ success: true, data: { templates } });
}

async function createTemplate(req, res) {
  if (req.user.role !== "ADMIN") throw new HttpError(403, "Only administrators can create invoice templates");
  const name = text(req.body.name, 120);
  const accentColor = text(req.body.accentColor ?? "#176b5d", 16);
  if (!name || !accentColor || !/^#[0-9a-f]{6}$/i.test(accentColor)) throw new HttpError(400, "Enter a template name and six-digit color");
  const isDefault = Boolean(req.body.isDefault);
  const template = await prisma.$transaction(async (transaction) => {
    if (isDefault) await transaction.invoiceTemplate.updateMany({ data: { isDefault: false } });
    return transaction.invoiceTemplate.create({ data: { createdById: req.user.id, name, header: optionalText(req.body.header, 300), footer: optionalText(req.body.footer, 500), accentColor, isDefault }, include: { createdBy: { select: { id: true, fullName: true } } } });
  });
  return res.status(201).json({ success: true, data: { template } });
}

async function updateTemplate(req, res) {
  if (req.user.role !== "ADMIN") throw new HttpError(403, "Only administrators can edit invoice templates");
  const id = Number(req.params.id);
  const existing = await prisma.invoiceTemplate.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, "Invoice template not found");
  const data = {};
  if (req.body.name !== undefined) { const name = text(req.body.name, 120); if (!name) throw new HttpError(400, "Enter a template name"); data.name = name; }
  if (req.body.header !== undefined) data.header = optionalText(req.body.header, 300);
  if (req.body.footer !== undefined) data.footer = optionalText(req.body.footer, 500);
  if (req.body.accentColor !== undefined) { const color = text(req.body.accentColor, 16); if (!color || !/^#[0-9a-f]{6}$/i.test(color)) throw new HttpError(400, "Use a six-digit color"); data.accentColor = color; }
  if (req.body.isDefault !== undefined) data.isDefault = Boolean(req.body.isDefault);
  const template = await prisma.$transaction(async (transaction) => {
    if (data.isDefault) await transaction.invoiceTemplate.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
    return transaction.invoiceTemplate.update({ where: { id }, data, include: { createdBy: { select: { id: true, fullName: true } } } });
  });
  return res.json({ success: true, data: { template } });
}

async function deleteTemplate(req, res) {
  if (req.user.role !== "ADMIN") throw new HttpError(403, "Only administrators can delete invoice templates");
  const id = Number(req.params.id);
  await prisma.invoiceTemplate.delete({ where: { id } }).catch(() => { throw new HttpError(404, "Invoice template not found"); });
  return res.json({ success: true });
}

async function listAttachments(req, res) {
  const resourceType = optionalText(req.query.resourceType, 40);
  const resourceId = optionalText(req.query.resourceId, 100);
  const attachments = await prisma.fileAttachment.findMany({ where: { ...(resourceType ? { resourceType } : {}), ...(resourceId ? { resourceId } : {}) }, include: { uploadedBy: { select: { id: true, fullName: true } } }, take: 50, orderBy: { createdAt: "desc" } });
  return res.json({ success: true, data: { attachments: attachments.map((attachment) => serializeAttachment(attachment)) } });
}

async function createAttachment(req, res) {
  const name = text(req.body.name, 180);
  const mimeType = text(req.body.mimeType, 100);
  const content = String(req.body.content || "");
  const sizeBytes = Number(req.body.sizeBytes);
  if (!name || !mimeType || !content || !Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_ATTACHMENT_BYTES || content.length > 500_000) {
    throw new HttpError(400, "Attach a file smaller than 350 KB");
  }
  const attachment = await prisma.fileAttachment.create({ data: { uploadedById: req.user.id, name, mimeType, sizeBytes, content, resourceType: optionalText(req.body.resourceType, 40), resourceId: optionalText(req.body.resourceId, 100) }, include: { uploadedBy: { select: { id: true, fullName: true } } } });
  return res.status(201).json({ success: true, data: { attachment: serializeAttachment(attachment) } });
}

async function getAttachment(req, res) {
  const id = Number(req.params.id);
  const attachment = await prisma.fileAttachment.findUnique({ where: { id }, include: { uploadedBy: { select: { id: true, fullName: true } } } });
  if (!attachment) throw new HttpError(404, "Attachment not found");
  if (attachment.uploadedById !== req.user.id && req.user.role !== "ADMIN") throw new HttpError(403, "You cannot access this attachment");
  return res.json({ success: true, data: { attachment: serializeAttachment(attachment, true) } });
}

async function deleteAttachment(req, res) {
  const id = Number(req.params.id);
  const attachment = await prisma.fileAttachment.findUnique({ where: { id } });
  if (!attachment) throw new HttpError(404, "Attachment not found");
  if (attachment.uploadedById !== req.user.id && req.user.role !== "ADMIN") throw new HttpError(403, "You cannot delete this attachment");
  await prisma.fileAttachment.delete({ where: { id } });
  return res.json({ success: true });
}

async function createDeliveryLink(req, res) {
  const channel = String(req.body.channel || "").toUpperCase();
  const recipient = text(req.body.recipient, 254);
  const message = text(req.body.message, 1800);
  if (!recipient || !message || !["EMAIL", "SMS", "WHATSAPP"].includes(channel)) throw new HttpError(400, "Choose an email, SMS, or WhatsApp recipient and message");
  const encoded = encodeURIComponent(message);
  let url;
  if (channel === "EMAIL") url = `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent("StockFlow invoice")}&body=${encoded}`;
  if (channel === "SMS") url = `sms:${recipient}?body=${encoded}`;
  if (channel === "WHATSAPP") url = `https://wa.me/${recipient.replace(/\D/g, "")}?text=${encoded}`;
  await prisma.auditLog.create({ data: { userId: req.user.id, action: `PREPARE_${channel}_INVOICE`, entityType: "COMMUNICATION", details: { recipient } } });
  return res.json({ success: true, data: { channel, url } });
}

module.exports = {
  getWorkspace, updateSettings, updatePreferences, globalSearch,
  listNotes, createNote, updateNote, deleteNote,
  listCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent,
  listFavorites, createFavorite, deleteFavorite,
  listTemplates, createTemplate, updateTemplate, deleteTemplate,
  listAttachments, createAttachment, getAttachment, deleteAttachment,
  createDeliveryLink,
};
