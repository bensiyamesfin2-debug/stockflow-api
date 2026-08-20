const prisma = require("../config/prisma");
const HttpError = require("../utils/HttpError");
const { moneyToCents, centsToMoney } = require("../utils/money");
const { runSerializableTransaction } = require("../utils/transaction");

function parseDate(value) {
  if (!value) return new Date();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

async function currentBalanceCents(client = prisma) {
  const entries = await client.ownerExpenseEntry.findMany({ select: { entryType: true, amount: true } });
  return entries.reduce((balance, entry) => {
    const amount = moneyToCents(entry.amount.toFixed(2));
    return entry.entryType === "IN" ? balance + amount : balance - amount;
  }, 0n);
}

async function listOwnerExpenseEntries(req, res) {
  const [entries, balanceCents] = await Promise.all([
    prisma.ownerExpenseEntry.findMany({
      include: { createdBy: { select: { id: true, fullName: true, username: true, role: true } } },
      orderBy: [{ transactionDate: "desc" }, { id: "desc" }],
      take: 500,
    }),
    currentBalanceCents(),
  ]);
  const totals = entries.reduce((summary, entry) => {
    const amount = moneyToCents(entry.amount.toFixed(2));
    summary[entry.entryType] += amount;
    return summary;
  }, { IN: 0n, OUT: 0n });
  return res.json({ success: true, data: { balance: centsToMoney(balanceCents), totalIn: centsToMoney(totals.IN), totalOut: centsToMoney(totals.OUT), entries } });
}

async function createOwnerExpenseEntry(req, res) {
  const entryType = String(req.body.entryType || "").trim().toUpperCase();
  const amountCents = moneyToCents(req.body.amount);
  const transactionDate = parseDate(req.body.transactionDate);
  const note = String(req.body.note || "").trim().slice(0, 1000) || null;
  if (!new Set(["IN", "OUT"]).has(entryType)) return res.status(400).json({ success: false, message: "Choose Funds added or Spending" });
  if (amountCents === null || amountCents <= 0n) return res.status(400).json({ success: false, message: "Amount must be greater than zero" });
  if (!transactionDate) return res.status(400).json({ success: false, message: "Transaction date is invalid" });

  const entry = await runSerializableTransaction(async (transaction) => {
    const balanceCents = await currentBalanceCents(transaction);
    if (entryType === "OUT" && amountCents > balanceCents) throw new HttpError(409, "Spending cannot exceed the available expense-account balance");
    const nextBalance = entryType === "IN" ? balanceCents + amountCents : balanceCents - amountCents;
    const created = await transaction.ownerExpenseEntry.create({ data: { entryType, amount: centsToMoney(amountCents), balanceAfter: centsToMoney(nextBalance), note, transactionDate, createdById: req.user.id }, include: { createdBy: { select: { id: true, fullName: true, username: true, role: true } } } });
    await transaction.auditLog.create({ data: { userId: req.user.id, action: `OWNER_EXPENSE_${entryType}`, entityType: "OWNER_EXPENSE", entityId: created.id, details: { amount: centsToMoney(amountCents), balanceAfter: centsToMoney(nextBalance), note } } });
    return created;
  });
  return res.status(201).json({ success: true, message: entryType === "IN" ? "Funds added to the Owner Expense Account" : "Spending recorded", data: { entry } });
}

module.exports = { listOwnerExpenseEntries, createOwnerExpenseEntry, currentBalanceCents };
