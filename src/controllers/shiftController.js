const prisma = require("../config/prisma");
const HttpError = require("../utils/HttpError");
const { normalizeMoney, normalizeOptionalText } = require("../utils/validation");
const { moneyToCents, centsToMoney } = require("../utils/money");
const { runSerializableTransaction } = require("../utils/transaction");

const shiftInclude = {
  user: { select: { id: true, fullName: true, username: true, role: true } },
  sales: {
    select: {
      id: true,
      saleNumber: true,
      totalAmount: true,
      discountAmount: true,
      status: true,
      createdAt: true,
      payments: { select: { paymentMethod: true, amount: true, status: true } },
    },
    orderBy: { createdAt: "desc" },
  },
};

function serializeShift(shift) {
  const validSales = shift.sales.filter((sale) => sale.status !== "CANCELLED");
  return {
    ...shift,
    summary: {
      sales: validSales.length,
      revenue: centsToMoney(validSales.reduce(
        (total, sale) => total + moneyToCents(sale.totalAmount.toFixed(2)),
        0n
      )),
      cashCollected: centsToMoney(validSales.reduce(
        (total, sale) => total + sale.payments
          .filter((payment) => payment.status === "COMPLETED" && payment.paymentMethod === "CASH")
          .reduce((paymentTotal, payment) => paymentTotal + moneyToCents(payment.amount.toFixed(2)), 0n),
        0n
      )),
    },
  };
}

async function listShifts(req, res) {
  const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
  if (status && !new Set(["OPEN", "CLOSED"]).has(status)) {
    return res.status(400).json({ success: false, message: "Invalid shift status" });
  }
  const requestedUserId = req.query.userId ? Number(req.query.userId) : undefined;
  if (requestedUserId !== undefined && (!Number.isInteger(requestedUserId) || requestedUserId <= 0)) {
    return res.status(400).json({ success: false, message: "Invalid user ID" });
  }
  const userId = req.user.role === "ADMIN" ? requestedUserId : req.user.id;
  const shifts = await prisma.shift.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(userId ? { userId } : {}),
    },
    include: shiftInclude,
    orderBy: { openedAt: "desc" },
    take: 100,
  });
  return res.json({ success: true, data: { shifts: shifts.map(serializeShift) } });
}

async function openShift(req, res) {
  const requestedUserId = req.body.userId === undefined ? req.user.id : Number(req.body.userId);
  if (!Number.isInteger(requestedUserId) || requestedUserId <= 0) {
    return res.status(400).json({ success: false, message: "Invalid user ID" });
  }
  if (req.user.role !== "ADMIN" && requestedUserId !== req.user.id) {
    return res.status(403).json({ success: false, message: "You can only open your own shift" });
  }
  const openingCash = normalizeMoney(req.body.openingCash ?? "0");
  if (openingCash === null) return res.status(400).json({ success: false, message: "Opening cash is invalid" });
  const notes = normalizeOptionalText(req.body.notes, 1000);
  if (req.body.notes && !notes) return res.status(400).json({ success: false, message: "Notes cannot exceed 1,000 characters" });

  try {
    const shift = await runSerializableTransaction(async (transaction) => {
      const user = await transaction.user.findUnique({ where: { id: requestedUserId } });
      if (!user || !user.isActive || !["ADMIN", "CASHIER"].includes(user.role)) {
        throw new HttpError(400, "Shifts can only be opened for an active administrator or cashier");
      }
      const active = await transaction.shift.findFirst({ where: { userId: requestedUserId, status: "OPEN" } });
      if (active) throw new HttpError(409, "This user already has an open shift");
      const created = await transaction.shift.create({
        data: { userId: requestedUserId, openingCash, notes },
        include: shiftInclude,
      });
      await transaction.auditLog.create({
        data: {
          userId: req.user.id,
          action: "OPEN_SHIFT",
          entityType: "SHIFT",
          entityId: created.id,
          details: { shiftUserId: requestedUserId, openingCash },
        },
      });
      return created;
    });
    return res.status(201).json({ success: true, message: "Shift opened", data: { shift: serializeShift(shift) } });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ success: false, message: "This user already has an open shift" });
    }
    throw error;
  }
}

async function closeShift(req, res) {
  const shiftId = Number(req.params.id);
  if (!Number.isInteger(shiftId) || shiftId <= 0) return res.status(400).json({ success: false, message: "Invalid shift ID" });
  const closingCash = normalizeMoney(req.body.closingCash);
  if (closingCash === null) return res.status(400).json({ success: false, message: "Closing cash is required and must be valid" });
  const notes = normalizeOptionalText(req.body.notes, 1000);
  if (req.body.notes && !notes) return res.status(400).json({ success: false, message: "Notes cannot exceed 1,000 characters" });

  const shift = await runSerializableTransaction(async (transaction) => {
    const existing = await transaction.shift.findUnique({ where: { id: shiftId } });
    if (!existing) throw new HttpError(404, "Shift not found");
    if (req.user.role !== "ADMIN" && existing.userId !== req.user.id) {
      throw new HttpError(403, "You can only close your own shift");
    }
    if (existing.status === "CLOSED") throw new HttpError(409, "Shift is already closed");
    const cashPayments = await transaction.payment.findMany({
      where: {
        paymentMethod: "CASH",
        status: "COMPLETED",
        sale: { shiftId, status: { not: "CANCELLED" } },
      },
      select: { amount: true },
    });
    const expectedCents = moneyToCents(existing.openingCash.toFixed(2)) +
      cashPayments.reduce((total, payment) => total + moneyToCents(payment.amount.toFixed(2)), 0n);
    const closed = await transaction.shift.update({
      where: { id: shiftId },
      data: {
        status: "CLOSED",
        closingCash,
        expectedCash: centsToMoney(expectedCents),
        closedAt: new Date(),
        notes: notes ? [existing.notes, notes].filter(Boolean).join("\n") : existing.notes,
      },
      include: shiftInclude,
    });
    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "CLOSE_SHIFT",
        entityType: "SHIFT",
        entityId: shiftId,
        details: {
          expectedCash: centsToMoney(expectedCents),
          closingCash,
          difference: centsToMoney(moneyToCents(closingCash) - expectedCents),
        },
      },
    });
    return closed;
  });
  return res.json({ success: true, message: "Shift closed", data: { shift: serializeShift(shift) } });
}

module.exports = { listShifts, openShift, closeShift };
