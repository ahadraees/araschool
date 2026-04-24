import { Router } from "express";
import { db, incomeTable, expensesTable, vouchersTable, feesTable, studentsTable } from "@workspace/db";
import { eq, and, gte, lte, desc, sql, between } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth.js";

const router = Router();

// ─── Helper ──────────────────────────────────────────────────────────────────

function dateRange(period: string, month?: number, year?: number) {
  const now = new Date();
  const y = year ?? now.getFullYear();
  const m = month ?? (now.getMonth() + 1);
  if (period === "today") {
    const d = now.toISOString().slice(0, 10);
    return { from: d, to: d };
  }
  if (period === "monthly") {
    const from = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const to = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    return { from, to };
  }
  // yearly
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

async function getIncomeSum(schoolId: number, from: string, to: string) {
  const [manualRow] = await db
    .select({ total: sql<string>`coalesce(sum(${incomeTable.amount}), 0)` })
    .from(incomeTable)
    .where(and(eq(incomeTable.schoolId, schoolId), gte(incomeTable.date, from), lte(incomeTable.date, to)));

  const [feeRow] = await db
    .select({ total: sql<string>`coalesce(sum(${feesTable.paidAmount}), 0)` })
    .from(feesTable)
    .where(and(
      eq(feesTable.schoolId, schoolId),
      eq(feesTable.status, "paid"),
      gte(feesTable.paidDate, from),
      lte(feesTable.paidDate, to),
    ));

  return parseFloat(manualRow?.total || "0") + parseFloat(feeRow?.total || "0");
}

async function getExpenseSum(schoolId: number, from: string, to: string) {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${expensesTable.amount}), 0)` })
    .from(expensesTable)
    .where(and(eq(expensesTable.schoolId, schoolId), gte(expensesTable.date, from), lte(expensesTable.date, to)));
  return parseFloat(row?.total || "0");
}

// ─── GET /summary ─────────────────────────────────────────────────────────────

router.get("/summary", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const month = Number(req.query.month) || (new Date().getMonth() + 1);
  const year  = Number(req.query.year)  || new Date().getFullYear();

  const todayRange   = dateRange("today");
  const monthRange   = dateRange("monthly", month, year);
  const yearRange    = dateRange("yearly", undefined, year);

  const [
    incomeToday, incomeMonth, incomeYear,
    expenseToday, expenseMonth, expenseYear,
    feeCollected,
  ] = await Promise.all([
    getIncomeSum(schoolId, todayRange.from, todayRange.to),
    getIncomeSum(schoolId, monthRange.from, monthRange.to),
    getIncomeSum(schoolId, yearRange.from, yearRange.to),
    getExpenseSum(schoolId, todayRange.from, todayRange.to),
    getExpenseSum(schoolId, monthRange.from, monthRange.to),
    getExpenseSum(schoolId, yearRange.from, yearRange.to),
    // also pull fee collections from fees table (paid fees this month)
    db.select({ total: sql<string>`coalesce(sum(${feesTable.paidAmount}), 0)` })
      .from(feesTable)
      .where(and(
        eq(feesTable.schoolId, schoolId),
        eq(feesTable.status, "paid"),
        gte(feesTable.paidDate, monthRange.from),
        lte(feesTable.paidDate, monthRange.to),
      )).then(r => parseFloat(r[0]?.total || "0")),
  ]);

  res.json({
    income: { today: incomeToday, month: incomeMonth, year: incomeYear },
    expense: { today: expenseToday, month: expenseMonth, year: expenseYear },
    profit: {
      today: incomeToday - expenseToday,
      month: incomeMonth - expenseMonth,
      year: incomeYear - expenseYear,
    },
    feeCollectedThisMonth: feeCollected,
  });
});

// ─── GET /monthly-chart ───────────────────────────────────────────────────────

router.get("/monthly-chart", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const year = Number(req.query.year) || new Date().getFullYear();

  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const rows = await Promise.all(
    months.map(async (m) => {
      const { from, to } = dateRange("monthly", m, year);
      const [inc, exp] = await Promise.all([
        getIncomeSum(schoolId, from, to),
        getExpenseSum(schoolId, from, to),
      ]);
      return { month: m, income: inc, expense: exp, profit: inc - exp };
    })
  );
  res.json(rows);
});

// ─── GET /income ──────────────────────────────────────────────────────────────
// Returns manual income records + auto-synced paid fees (merged, source field distinguishes them)

router.get("/income", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const { type, from, to } = req.query as Record<string, string>;

  // ── 1. Manual income records ────────────────────────────────────────────────
  const incConditions = [eq(incomeTable.schoolId, schoolId)];
  // Only filter by type when explicitly requested and type is NOT "fee"
  // (fee_auto entries from feesTable are shown separately; manually-added "fee" type also included)
  if (type && type !== "all") incConditions.push(eq(incomeTable.type, type));
  if (from) incConditions.push(gte(incomeTable.date, from));
  if (to)   incConditions.push(lte(incomeTable.date, to));

  const manualRows = await db
    .select({
      id: incomeTable.id,
      type: incomeTable.type,
      amount: incomeTable.amount,
      date: incomeTable.date,
      category: incomeTable.category,
      receiptNo: incomeTable.receiptNo,
      description: incomeTable.description,
      paymentMethod: incomeTable.paymentMethod,
      studentId: incomeTable.studentId,
      studentName: studentsTable.name,
      createdAt: incomeTable.createdAt,
    })
    .from(incomeTable)
    .leftJoin(studentsTable, eq(incomeTable.studentId, studentsTable.id))
    .where(and(...incConditions))
    .orderBy(desc(incomeTable.createdAt));

  // ── 2. Auto-sync paid fees ──────────────────────────────────────────────────
  // Skip fee rows if type filter is something other than "all" or "fee"
  let feeRows: any[] = [];
  if (!type || type === "all" || type === "fee") {
    const feeConditions = [
      eq(feesTable.schoolId, schoolId),
      eq(feesTable.status, "paid"),
    ];
    if (from) feeConditions.push(gte(feesTable.paidDate, from));
    if (to)   feeConditions.push(lte(feesTable.paidDate, to));

    const paidFees = await db
      .select({
        id: feesTable.id,
        paidAmount: feesTable.paidAmount,
        paidDate: feesTable.paidDate,
        feeType: feesTable.feeType,
        paymentMethod: feesTable.paymentMethod,
        studentId: feesTable.studentId,
        studentName: studentsTable.name,
        createdAt: feesTable.updatedAt,
      })
      .from(feesTable)
      .leftJoin(studentsTable, eq(feesTable.studentId, studentsTable.id))
      .where(and(...feeConditions));

    feeRows = paidFees.map(f => ({
      id: `fee_${f.id}`,
      type: "fee",
      amount: f.paidAmount,
      date: f.paidDate,
      category: "Fee Collection",
      receiptNo: null,
      description: `${(f.feeType || "Monthly").replace(/_/g, " ")} Fee — ${f.studentName || "Student"}`,
      paymentMethod: f.paymentMethod || "cash",
      studentId: f.studentId,
      studentName: f.studentName,
      createdAt: f.createdAt,
      source: "fee_auto",
    }));
  }

  // ── 3. Tag manual rows and merge ────────────────────────────────────────────
  const tagged = manualRows.map(r => ({ ...r, source: "manual" }));
  const merged = [...tagged, ...feeRows].sort((a, b) => {
    const da = new Date(a.date || a.createdAt || 0).getTime();
    const db2 = new Date(b.date || b.createdAt || 0).getTime();
    return db2 - da;
  });

  res.json(merged);
});

// ─── POST /income ─────────────────────────────────────────────────────────────

router.post("/income", requireAuth, requireRole("super_admin", "admin", "accountant", "sub_admin"), async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const { type, amount, date, studentId, category, receiptNo, description, paymentMethod } = req.body;

  if (!type || !amount || !date) {
    res.status(400).json({ error: "type, amount, date are required" });
    return;
  }

  const [row] = await db.insert(incomeTable).values({
    schoolId,
    type,
    amount: parseFloat(amount).toString(),
    date,
    studentId: studentId || null,
    category: category || null,
    receiptNo: receiptNo || `INC-${Date.now()}`,
    description: description || null,
    paymentMethod: paymentMethod || "cash",
    createdBy: req.user!.id,
  }).returning();

  res.status(201).json(row);
});

// ─── DELETE /income/:id ───────────────────────────────────────────────────────

router.delete("/income/:id", requireAuth, requireRole("super_admin", "admin", "accountant", "sub_admin"), async (req, res) => {
  const schoolId = req.user!.schoolId!;
  await db.delete(incomeTable).where(and(eq(incomeTable.id, Number(req.params.id)), eq(incomeTable.schoolId, schoolId)));
  res.json({ success: true });
});

// ─── GET /expenses ────────────────────────────────────────────────────────────

router.get("/expenses", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const { category, from, to, limit = "50", offset = "0" } = req.query as Record<string, string>;

  const conditions = [eq(expensesTable.schoolId, schoolId)];
  if (category && category !== "all") conditions.push(eq(expensesTable.category, category));
  if (from) conditions.push(gte(expensesTable.date, from));
  if (to)   conditions.push(lte(expensesTable.date, to));

  const rows = await db
    .select()
    .from(expensesTable)
    .where(and(...conditions))
    .orderBy(desc(expensesTable.createdAt))
    .limit(parseInt(limit))
    .offset(parseInt(offset));

  res.json(rows);
});

// ─── POST /expenses ───────────────────────────────────────────────────────────

router.post("/expenses", requireAuth, requireRole("super_admin", "admin", "accountant", "sub_admin"), async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const { category, subCategory, amount, date, description, paidTo, paymentMethod, status, attachmentData, attachmentName, teacherId } = req.body;

  if (!category || !amount || !date) {
    res.status(400).json({ error: "category, amount, date are required" });
    return;
  }

  const [row] = await db.insert(expensesTable).values({
    schoolId,
    category,
    subCategory: subCategory || null,
    amount: parseFloat(amount).toString(),
    date,
    description: description || null,
    paidTo: paidTo || null,
    paymentMethod: paymentMethod || "cash",
    status: status || "paid",
    teacherId: teacherId ? Number(teacherId) : null,
    attachmentData: attachmentData || null,
    attachmentName: attachmentName || null,
    createdBy: req.user!.id,
  }).returning();

  res.status(201).json(row);
});

// ─── DELETE /expenses/:id ─────────────────────────────────────────────────────

router.delete("/expenses/:id", requireAuth, requireRole("super_admin", "admin", "accountant", "sub_admin"), async (req, res) => {
  const schoolId = req.user!.schoolId!;
  await db.delete(expensesTable).where(and(eq(expensesTable.id, Number(req.params.id)), eq(expensesTable.schoolId, schoolId)));
  res.json({ success: true });
});

// ─── GET /vouchers ────────────────────────────────────────────────────────────

router.get("/vouchers", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const { type, from, to, limit = "50", offset = "0" } = req.query as Record<string, string>;

  const conditions = [eq(vouchersTable.schoolId, schoolId)];
  if (type && type !== "all") conditions.push(eq(vouchersTable.type, type));
  if (from) conditions.push(gte(vouchersTable.date, from));
  if (to)   conditions.push(lte(vouchersTable.date, to));

  const rows = await db
    .select()
    .from(vouchersTable)
    .where(and(...conditions))
    .orderBy(desc(vouchersTable.createdAt))
    .limit(parseInt(limit))
    .offset(parseInt(offset));

  res.json(rows);
});

// ─── POST /vouchers ───────────────────────────────────────────────────────────

router.post("/vouchers", requireAuth, requireRole("super_admin", "admin", "accountant", "sub_admin"), async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const { type, date, category, amount, description, party, paymentMethod } = req.body;

  if (!type || !amount || !date) {
    res.status(400).json({ error: "type, amount, date are required" });
    return;
  }

  const prefix = type === "receipt" ? "RCV" : "PMT";
  const voucherNo = `${prefix}-${Date.now()}`;

  const [row] = await db.insert(vouchersTable).values({
    schoolId,
    type,
    voucherNo,
    date,
    category: category || null,
    amount: parseFloat(amount).toString(),
    description: description || null,
    party: party || null,
    paymentMethod: paymentMethod || "cash",
    createdBy: req.user!.id,
  }).returning();

  res.status(201).json(row);
});

// ─── DELETE /vouchers/:id ─────────────────────────────────────────────────────

router.delete("/vouchers/:id", requireAuth, requireRole("super_admin", "admin", "accountant", "sub_admin"), async (req, res) => {
  const schoolId = req.user!.schoolId!;
  await db.delete(vouchersTable).where(and(eq(vouchersTable.id, Number(req.params.id)), eq(vouchersTable.schoolId, schoolId)));
  res.json({ success: true });
});

// ─── GET /category-summary ────────────────────────────────────────────────────

router.get("/category-summary", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const { from, to } = req.query as Record<string, string>;

  const incConditions = [eq(incomeTable.schoolId, schoolId)];
  const expConditions = [eq(expensesTable.schoolId, schoolId)];
  if (from) { incConditions.push(gte(incomeTable.date, from)); expConditions.push(gte(expensesTable.date, from)); }
  if (to)   { incConditions.push(lte(incomeTable.date, to));   expConditions.push(lte(expensesTable.date, to)); }

  const [incCats, expCats] = await Promise.all([
    db.select({
      type: incomeTable.type,
      total: sql<string>`coalesce(sum(${incomeTable.amount}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(incomeTable)
    .where(and(...incConditions))
    .groupBy(incomeTable.type),

    db.select({
      category: expensesTable.category,
      total: sql<string>`coalesce(sum(${expensesTable.amount}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(expensesTable)
    .where(and(...expConditions))
    .groupBy(expensesTable.category),
  ]);

  res.json({ income: incCats, expenses: expCats });
});

export default router;
