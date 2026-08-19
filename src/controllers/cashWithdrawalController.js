const prisma = require("../config/prisma");
const { normalizeMoney } = require("../utils/validation");

function normalizeCashWithdrawal(body) {
  const errors = [];
  const data = {};

  const amount = normalizeMoney(body.amount);
  if (amount === null || Number(amount) <= 0) {
    errors.push("Amount must be a positive amount with at most 2 decimal places");
  } else {
    data.amount = amount;
  }

  const reason = String(body.reason || "").trim().replace(/\s+/g, " ");
  if (reason.length < 3 || reason.length > 500) {
    errors.push("Reason must explain what the money was for, between 3 and 500 characters");
  } else {
    data.reason = reason;
  }

  return { data, errors };
}

async function listCashWithdrawals(req, res) {
  const requestedUserId = req.query.userId ? Number(req.query.userId) : undefined;
  if (requestedUserId !== undefined && (!Number.isInteger(requestedUserId) || requestedUserId <= 0)) {
    return res.status(400).json({ success: false, message: "Invalid user ID" });
  }
  const userId = req.user.role === "ADMIN" ? requestedUserId : req.user.id;
  const withdrawals = await prisma.cashWithdrawal.findMany({
    where: userId ? { withdrawnById: userId } : {},
    include: { withdrawnBy: { select: { id: true, fullName: true, username: true } } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const total = withdrawals.reduce((sum, w) => sum + Number(w.amount), 0);
  return res.json({ success: true, data: { withdrawals, total } });
}

async function createCashWithdrawal(req, res) {
  const { data, errors } = normalizeCashWithdrawal(req.body);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

  const withdrawal = await prisma.$transaction(async (transaction) => {
    const created = await transaction.cashWithdrawal.create({
      data: { ...data, withdrawnById: req.user.id },
      include: { withdrawnBy: { select: { id: true, fullName: true, username: true } } },
    });
    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        action: "CASH_WITHDRAWAL",
        entityType: "CASH_WITHDRAWAL",
        entityId: created.id,
        details: { amount: created.amount, reason: created.reason },
      },
    });
    return created;
  });

  return res.status(201).json({ success: true, message: "Withdrawal recorded", data: { withdrawal } });
}

module.exports = {
  normalizeCashWithdrawal,
  listCashWithdrawals,
  createCashWithdrawal,
};
