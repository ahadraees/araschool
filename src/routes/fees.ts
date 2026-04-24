import { Router } from "express";
import { db, feesTable, studentsTable, classesTable, notificationsTable, usersTable, parentStudentsTable, schoolsTable, smsSettingsTable } from "@workspace/db";
import { eq, and, lt, or, isNull, desc, sql, isNotNull, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { sendSmsOrWhatsapp } from "./sms-settings.js";

const router = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

type FeeType = "monthly" | "annual" | "stationery" | "conveyance" | "admission";

const FEE_TYPE_PREFIX: Record<FeeType, string> = {
  monthly: "CHN",
  annual: "ANN",
  stationery: "STA",
  conveyance: "CVY",
  admission: "ADM",
};

function generateChallanNumber(schoolId: number, year: number, month: number, studentId: number, feeType: FeeType = "monthly"): string {
  const pad = (n: number, len: number) => String(n).padStart(len, "0");
  const prefix = FEE_TYPE_PREFIX[feeType] ?? "CHN";
  if (feeType === "monthly") {
    return `${prefix}-${schoolId}-${year}${pad(month, 2)}-${pad(studentId, 4)}`;
  }
  return `${prefix}-${schoolId}-${year}-${pad(studentId, 4)}`;
}

async function sendFeeNotification(
  schoolId: number,
  studentId: number,
  title: string,
  message: string,
  type: "info" | "warning" | "alert" | "success" = "info",
) {
  const student = await db.query.studentsTable.findFirst({ where: eq(studentsTable.id, studentId) });
  if (!student?.userId) return;

  // Notify student
  await db.insert(notificationsTable).values({
    schoolId,
    recipientUserId: student.userId,
    targetStudentId: studentId,
    title,
    message,
    type,
  });

  // Notify linked parents
  const parentLinks = await db.select()
    .from(parentStudentsTable)
    .where(eq(parentStudentsTable.studentId, studentId));

  for (const link of parentLinks) {
    await db.insert(notificationsTable).values({
      schoolId,
      recipientUserId: link.parentUserId,
      title,
      message,
      type,
    });
  }

  // ── Auto SMS to parent ──────────────────────────────────────────────────
  try {
    const smsSettings = await db.query.smsSettingsTable.findFirst({
      where: eq(smsSettingsTable.schoolId, schoolId),
    });
    if (smsSettings?.notifyFeesDue && smsSettings.smsEnabled && parentLinks.length > 0) {
      const parentUserIds = parentLinks.map(l => l.parentUserId).filter(Boolean) as number[];
      if (parentUserIds.length > 0) {
        const parents = await db.select({ phone: usersTable.phone })
          .from(usersTable).where(inArray(usersTable.id, parentUserIds));
        for (const parent of parents) {
          if (parent.phone) await sendSmsOrWhatsapp(smsSettings, parent.phone, message).catch(() => null);
        }
      }
    }
  } catch { /* SMS failure should not crash fee generation */ }
}

// ─── GET /summary ────────────────────────────────────────────────────────────

router.get("/summary", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId;
  const month = req.query.month ? Number(req.query.month) : new Date().getMonth() + 1;
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();

  const conditions = [eq(feesTable.month, month), eq(feesTable.year, year)];
  if (schoolId) conditions.push(eq(feesTable.schoolId, schoolId));

  const fees = await db.select().from(feesTable).where(and(...conditions));

  const totalExpected = fees.reduce((sum, f) => sum + parseFloat(f.amount as string) + parseFloat(f.lateFee as string), 0);
  const totalCollected = fees.reduce((sum, f) => sum + parseFloat(f.paidAmount as string), 0);
  const totalPending = totalExpected - totalCollected;
  const paidCount = fees.filter(f => f.status === "paid").length;
  const unpaidCount = fees.filter(f => f.status === "unpaid").length;
  const overdueCount = fees.filter(f => f.status === "overdue").length;
  const partialCount = fees.filter(f => f.status === "partial").length;
  const totalOverdue = fees.filter(f => f.status === "overdue").reduce((sum, f) => sum + parseFloat(f.amount as string) + parseFloat(f.lateFee as string), 0);

  res.json({ totalExpected, totalCollected, totalPending, totalOverdue, paidCount, unpaidCount, overdueCount, partialCount, totalStudents: fees.length });
});

// ─── GET / ────────────────────────────────────────────────────────────────────

router.get("/", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId;
  const studentId = req.query.studentId ? Number(req.query.studentId) : undefined;
  const classId = req.query.classId ? Number(req.query.classId) : undefined;
  const status = req.query.status as string | undefined;
  const month = req.query.month ? Number(req.query.month) : undefined;
  const year = req.query.year ? Number(req.query.year) : undefined;

  const feeTypeFilter = req.query.feeType as string | undefined;
  const conditions = [];
  if (schoolId) conditions.push(eq(feesTable.schoolId, schoolId));
  if (studentId) conditions.push(eq(feesTable.studentId, studentId));
  if (status) conditions.push(eq(feesTable.status, status));
  if (month) conditions.push(eq(feesTable.month, month));
  if (year) conditions.push(eq(feesTable.year, year));
  if (feeTypeFilter && feeTypeFilter !== "all") conditions.push(eq(feesTable.feeType, feeTypeFilter));

  const fees = await db
    .select({
      id: feesTable.id,
      studentId: feesTable.studentId,
      schoolId: feesTable.schoolId,
      challanNumber: feesTable.challanNumber,
      amount: feesTable.amount,
      tuitionFee: feesTable.tuitionFee,
      otherCharges: feesTable.otherCharges,
      paidAmount: feesTable.paidAmount,
      lateFee: feesTable.lateFee,
      lateFeeApplied: feesTable.lateFeeApplied,
      month: feesTable.month,
      year: feesTable.year,
      dueDate: feesTable.dueDate,
      paidDate: feesTable.paidDate,
      status: feesTable.status,
      paymentMethod: feesTable.paymentMethod,
      receiptNumber: feesTable.receiptNumber,
      remarks: feesTable.remarks,
      feeType: feesTable.feeType,
      createdAt: feesTable.createdAt,
      studentName: studentsTable.name,
      studentRollNumber: studentsTable.rollNumber,
      className: classesTable.name,
      classSection: classesTable.section,
      schoolName: schoolsTable.name,
      hasProof: sql<boolean>`(${feesTable.paymentProofData} IS NOT NULL)`,
      paymentProofName: feesTable.paymentProofName,
    })
    .from(feesTable)
    .leftJoin(studentsTable, eq(feesTable.studentId, studentsTable.id))
    .leftJoin(classesTable, eq(studentsTable.classId, classesTable.id))
    .leftJoin(schoolsTable, eq(feesTable.schoolId, schoolsTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(feesTable.createdAt));

  if (classId) {
    const classStudents = await db.select({ id: studentsTable.id })
      .from(studentsTable).where(eq(studentsTable.classId, classId));
    const classStudentIds = new Set(classStudents.map(s => s.id));
    return res.json(fees.filter(f => classStudentIds.has(f.studentId)));
  }

  res.json(fees);
});

// ─── POST /generate-annual ────────────────────────────────────────────────────

router.post("/generate-annual", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const { year, amount, dueDate, classId } = req.body;
  const feeAmt = parseFloat(amount) || 0;

  const studentQuery = db.select().from(studentsTable)
    .where(and(eq(studentsTable.schoolId, schoolId), eq(studentsTable.isActive, true)));
  let allStudents = await studentQuery;
  if (classId) allStudents = allStudents.filter(s => s.classId === Number(classId));

  let created = 0; let skipped = 0;
  const createdFees = [];

  for (const student of allStudents) {
    const existing = await db.query.feesTable.findFirst({
      where: and(
        eq(feesTable.studentId, student.id),
        eq(feesTable.year, year),
        eq(feesTable.feeType, "annual"),
      ),
    });
    if (existing) { skipped++; continue; }

    const challanNumber = generateChallanNumber(schoolId, year, 1, student.id, "annual");
    const receiptNumber = `RCP-ANN-${Date.now()}-${student.id}`;

    const [fee] = await db.insert(feesTable).values({
      studentId: student.id, schoolId,
      challanNumber, amount: feeAmt.toString(),
      tuitionFee: feeAmt.toString(), otherCharges: "0",
      lateFee: "0", month: 1, year, dueDate, receiptNumber, feeType: "annual",
    }).returning();

    createdFees.push(fee);
    created++;

    await sendFeeNotification(schoolId, student.id,
      `Annual Fee Challan — ${year}`,
      `Your annual fee challan for ${year} has been generated. Amount: Rs. ${feeAmt.toLocaleString()}. Due Date: ${dueDate || "N/A"}. Challan No: ${challanNumber}`,
      "info");
  }

  res.json({ created, skipped, total: allStudents.length, fees: createdFees });
});

// ─── POST /generate-stationery ────────────────────────────────────────────────

router.post("/generate-stationery", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const { year, month, amount, dueDate, classId } = req.body;
  const feeAmt = parseFloat(amount) || 0;
  const feeMonth = Number(month) || 1;
  const feeYear = Number(year) || new Date().getFullYear();

  const studentQuery = db.select().from(studentsTable)
    .where(and(eq(studentsTable.schoolId, schoolId), eq(studentsTable.isActive, true)));
  let allStudents = await studentQuery;
  if (classId) allStudents = allStudents.filter(s => s.classId === Number(classId));

  let created = 0; let skipped = 0;
  const createdFees = [];

  for (const student of allStudents) {
    const existing = await db.query.feesTable.findFirst({
      where: and(
        eq(feesTable.studentId, student.id),
        eq(feesTable.year, feeYear),
        eq(feesTable.month, feeMonth),
        eq(feesTable.feeType, "stationery"),
      ),
    });
    if (existing) { skipped++; continue; }

    const challanNumber = generateChallanNumber(schoolId, feeYear, feeMonth, student.id, "stationery");
    const receiptNumber = `RCP-STA-${Date.now()}-${student.id}`;

    const [fee] = await db.insert(feesTable).values({
      studentId: student.id, schoolId,
      challanNumber, amount: feeAmt.toString(),
      tuitionFee: "0", otherCharges: feeAmt.toString(),
      lateFee: "0", month: feeMonth, year: feeYear, dueDate, receiptNumber, feeType: "stationery",
    }).returning();

    createdFees.push(fee);
    created++;

    const MONTHS = ["","January","February","March","April","May","June","July","August","September","October","November","December"];
    await sendFeeNotification(schoolId, student.id,
      `Stationery Fee Challan — ${MONTHS[feeMonth]} ${feeYear}`,
      `Your stationery fee challan for ${MONTHS[feeMonth]} ${feeYear} has been generated. Amount: Rs. ${feeAmt.toLocaleString()}. Due Date: ${dueDate || "N/A"}. Challan No: ${challanNumber}`,
      "info");
  }

  res.json({ created, skipped, total: allStudents.length, fees: createdFees });
});

// ─── POST /generate-conveyance ────────────────────────────────────────────────

router.post("/generate-conveyance", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const { year, month, amount, dueDate, classId } = req.body;
  const feeAmt = parseFloat(amount) || 0;
  const feeMonth = Number(month) || 1;
  const feeYear = Number(year) || new Date().getFullYear();

  let allStudents = await db.select().from(studentsTable)
    .where(and(
      eq(studentsTable.schoolId, schoolId),
      eq(studentsTable.isActive, true),
      eq(studentsTable.conveyance, "Yes"),
    ));
  if (classId) allStudents = allStudents.filter(s => s.classId === Number(classId));

  let created = 0; let skipped = 0;
  const createdFees = [];

  for (const student of allStudents) {
    const existing = await db.query.feesTable.findFirst({
      where: and(
        eq(feesTable.studentId, student.id),
        eq(feesTable.year, feeYear),
        eq(feesTable.month, feeMonth),
        eq(feesTable.feeType, "conveyance"),
      ),
    });
    if (existing) { skipped++; continue; }

    const challanNumber = generateChallanNumber(schoolId, feeYear, feeMonth, student.id, "conveyance");
    const receiptNumber = `RCP-CVY-${Date.now()}-${student.id}`;

    const [fee] = await db.insert(feesTable).values({
      studentId: student.id, schoolId,
      challanNumber, amount: feeAmt.toString(),
      tuitionFee: "0", otherCharges: feeAmt.toString(),
      lateFee: "0", month: feeMonth, year: feeYear, dueDate, receiptNumber, feeType: "conveyance",
    }).returning();

    createdFees.push(fee);
    created++;

    const MONTHS = ["","January","February","March","April","May","June","July","August","September","October","November","December"];
    await sendFeeNotification(schoolId, student.id,
      `Conveyance Fee Challan — ${MONTHS[feeMonth]} ${feeYear}`,
      `Your conveyance fee challan for ${MONTHS[feeMonth]} ${feeYear} has been generated. Amount: Rs. ${feeAmt.toLocaleString()}. Due Date: ${dueDate || "N/A"}. Challan No: ${challanNumber}`,
      "info");
  }

  res.json({ created, skipped, total: allStudents.length, fees: createdFees });
});

// ─── GET /:feeId ─────────────────────────────────────────────────────────────

router.get("/:feeId", requireAuth, async (req, res) => {
  const feeId = Number(req.params.feeId);
  const result = await db
    .select({
      id: feesTable.id,
      studentId: feesTable.studentId,
      schoolId: feesTable.schoolId,
      challanNumber: feesTable.challanNumber,
      amount: feesTable.amount,
      tuitionFee: feesTable.tuitionFee,
      otherCharges: feesTable.otherCharges,
      paidAmount: feesTable.paidAmount,
      lateFee: feesTable.lateFee,
      lateFeeApplied: feesTable.lateFeeApplied,
      month: feesTable.month,
      year: feesTable.year,
      dueDate: feesTable.dueDate,
      paidDate: feesTable.paidDate,
      status: feesTable.status,
      paymentMethod: feesTable.paymentMethod,
      receiptNumber: feesTable.receiptNumber,
      remarks: feesTable.remarks,
      feeType: feesTable.feeType,
      createdAt: feesTable.createdAt,
      studentName: studentsTable.name,
      studentRollNumber: studentsTable.rollNumber,
      className: classesTable.name,
      classSection: classesTable.section,
    })
    .from(feesTable)
    .leftJoin(studentsTable, eq(feesTable.studentId, studentsTable.id))
    .leftJoin(classesTable, eq(studentsTable.classId, classesTable.id))
    .where(eq(feesTable.id, feeId))
    .limit(1);

  if (!result[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(result[0]);
});

// ─── POST / ───────────────────────────────────────────────────────────────────

router.post("/", requireAuth, requireRole("super_admin", "admin", "accountant", "sub_admin"), async (req, res) => {
  const { studentId, schoolId, amount, tuitionFee, otherCharges, month, year, dueDate, remarks, lateFeeAmount, feeType } = req.body;
  const sid = schoolId || req.user!.schoolId!;
  const resolvedFeeType: FeeType = (feeType as FeeType) || "monthly";

  const now = new Date();
  const effectiveMonth = month ?? (now.getMonth() + 1);
  const effectiveYear = year ?? now.getFullYear();

  const challanNumber = generateChallanNumber(sid, effectiveYear, effectiveMonth, studentId, resolvedFeeType);
  const receiptNumber = `RCP-${FEE_TYPE_PREFIX[resolvedFeeType] ?? "CHN"}-${Date.now()}-${studentId}`;
  const tuition = tuitionFee ?? amount;
  const other = otherCharges ?? 0;
  const total = parseFloat(tuition) + parseFloat(other);

  const [fee] = await db.insert(feesTable).values({
    studentId,
    schoolId: sid,
    challanNumber,
    amount: total.toString(),
    tuitionFee: tuition.toString(),
    otherCharges: other.toString(),
    lateFee: (lateFeeAmount ?? 0).toString(),
    month: effectiveMonth,
    year: effectiveYear,
    dueDate,
    remarks,
    receiptNumber,
    feeType: resolvedFeeType,
  }).returning();

  res.status(201).json(fee);
});

// ─── POST /generate-monthly ───────────────────────────────────────────────────

router.post("/generate-monthly", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const {
    month,
    year,
    tuitionFee,
    otherCharges,
    dueDate,
    lateFeeAmount,
    classId,
  } = req.body;

  const tuition = parseFloat(tuitionFee) || 0;
  const other = parseFloat(otherCharges) || 0;
  const total = tuition + other;
  const lateFee = parseFloat(lateFeeAmount) || 0;

  const studentQuery = db.select().from(studentsTable).where(eq(studentsTable.schoolId, schoolId));
  const allStudents = classId
    ? (await studentQuery).filter(s => s.classId === classId)
    : await studentQuery;

  let created = 0;
  let skipped = 0;
  const createdFees = [];

  for (const student of allStudents) {
    const existing = await db.query.feesTable.findFirst({
      where: and(
        eq(feesTable.studentId, student.id),
        eq(feesTable.month, month),
        eq(feesTable.year, year),
        eq(feesTable.feeType, "monthly"),
      ),
    });

    if (existing) { skipped++; continue; }

    const challanNumber = generateChallanNumber(schoolId, year, month, student.id);
    const receiptNumber = `RCP-${Date.now()}-${student.id}`;

    const [fee] = await db.insert(feesTable).values({
      studentId: student.id,
      schoolId,
      challanNumber,
      amount: total.toString(),
      tuitionFee: tuition.toString(),
      otherCharges: other.toString(),
      lateFee: lateFee.toString(),
      month,
      year,
      dueDate,
      receiptNumber,
    }).returning();

    createdFees.push(fee);
    created++;

    // Notify student & parents
    const months = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    await sendFeeNotification(
      schoolId, student.id,
      `Fee Challan Generated — ${months[month]} ${year}`,
      `Your fee challan for ${months[month]} ${year} has been generated. Amount: Rs. ${total.toLocaleString()}. Due Date: ${dueDate || "N/A"}. Challan No: ${challanNumber}`,
      "info",
    );
  }

  res.json({ created, skipped, total: allStudents.length, fees: createdFees });
});

// ─── POST /apply-late-fees ────────────────────────────────────────────────────

router.post("/apply-late-fees", requireAuth, requireRole("super_admin", "admin", "accountant", "sub_admin"), async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const { lateFeeAmount } = req.body;
  const lateFee = parseFloat(lateFeeAmount) || 500;
  const today = new Date().toISOString().split("T")[0];

  const overdueRaw = await db
    .select()
    .from(feesTable)
    .where(
      and(
        eq(feesTable.schoolId, schoolId),
        or(
          eq(feesTable.status, "unpaid"),
          eq(feesTable.status, "partial"),
        ),
        lt(feesTable.dueDate!, today),
      )
    );

  let applied = 0;
  let alreadyApplied = 0;

  for (const fee of overdueRaw) {
    if (fee.lateFeeApplied) { alreadyApplied++; continue; }

    const newLateFee = parseFloat(fee.lateFee as string) + lateFee;
    const newTotal = parseFloat(fee.amount as string) + newLateFee;

    await db.update(feesTable).set({
      status: "overdue",
      lateFee: newLateFee.toString(),
      lateFeeApplied: true,
      amount: newTotal.toString(),
      updatedAt: new Date(),
    }).where(eq(feesTable.id, fee.id));

    await sendFeeNotification(
      schoolId, fee.studentId,
      "Late Fee Applied",
      `A late fee of Rs. ${lateFee.toLocaleString()} has been added to your ${["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][fee.month]} ${fee.year} challan. New total: Rs. ${newTotal.toLocaleString()}. Please pay immediately to avoid further penalties.`,
      "alert",
    );

    applied++;
  }

  res.json({ applied, alreadyApplied, total: overdueRaw.length });
});

// ─── POST /send-reminder ──────────────────────────────────────────────────────

router.post("/send-reminder", requireAuth, requireRole("super_admin", "admin", "accountant", "sub_admin"), async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const { month, year, status } = req.body;

  const conditions = [eq(feesTable.schoolId, schoolId)];
  if (month) conditions.push(eq(feesTable.month, month));
  if (year) conditions.push(eq(feesTable.year, year));
  if (status) conditions.push(eq(feesTable.status, status));

  const pendingFees = await db.select().from(feesTable).where(and(...conditions));
  const months = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  let sent = 0;
  for (const fee of pendingFees) {
    if (fee.status === "paid") continue;
    const msgMonth = months[fee.month];
    const isOverdue = fee.status === "overdue";
    await sendFeeNotification(
      schoolId, fee.studentId,
      isOverdue ? `⚠️ Overdue Fee — ${msgMonth} ${fee.year}` : `Fee Reminder — ${msgMonth} ${fee.year}`,
      isOverdue
        ? `Your fee challan for ${msgMonth} ${fee.year} (Challan: ${fee.challanNumber}) is overdue. Total due: Rs. ${(parseFloat(fee.amount as string)).toLocaleString()}. Please pay immediately.`
        : `Reminder: Your fee for ${msgMonth} ${fee.year} (Challan: ${fee.challanNumber}) is due. Amount: Rs. ${parseFloat(fee.amount as string).toLocaleString()}. Due Date: ${fee.dueDate || "N/A"}.`,
      isOverdue ? "alert" : "warning",
    );
    sent++;
  }

  res.json({ sent });
});

// ─── PUT /:feeId ──────────────────────────────────────────────────────────────

router.put("/:feeId", requireAuth, requireRole("super_admin", "admin", "accountant", "sub_admin"), async (req, res) => {
  const { paidAmount, paymentMethod, status, remarks, lateFee } = req.body;
  const feeId = Number(req.params.feeId);

  const fee = await db.query.feesTable.findFirst({ where: eq(feesTable.id, feeId) });
  if (!fee) { res.status(404).json({ error: "Fee not found" }); return; }

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (paidAmount !== undefined) updateData.paidAmount = paidAmount.toString();
  if (paymentMethod) updateData.paymentMethod = paymentMethod;
  if (status) updateData.status = status;
  if (remarks !== undefined) updateData.remarks = remarks;
  if (lateFee !== undefined) updateData.lateFee = lateFee.toString();
  if (status === "paid" && !updateData.paidDate) updateData.paidDate = new Date().toISOString().split("T")[0];

  const [updated] = await db.update(feesTable)
    .set(updateData)
    .where(eq(feesTable.id, feeId))
    .returning();

  // Send success notification when marked paid
  if (status === "paid") {
    const months = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    await sendFeeNotification(
      fee.schoolId, fee.studentId,
      `Fee Payment Confirmed — ${months[fee.month]} ${fee.year}`,
      `Your fee payment for ${months[fee.month]} ${fee.year} (Challan: ${fee.challanNumber}) has been confirmed. Amount paid: Rs. ${paidAmount?.toLocaleString() ?? parseFloat(fee.amount as string).toLocaleString()}. Thank you!`,
      "success",
    );
  }

  res.json(updated);
});

// ─── DELETE /:feeId ───────────────────────────────────────────────────────────

router.delete("/:feeId", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  await db.delete(feesTable).where(eq(feesTable.id, Number(req.params.feeId)));
  res.json({ success: true });
});

// ─── POST /:feeId/upload-proof ────────────────────────────────────────────────
// Any logged-in user can upload proof for their own challan

router.post("/:feeId/upload-proof", requireAuth, async (req, res) => {
  const feeId = Number(req.params.feeId);
  const { proofData, proofName } = req.body as { proofData: string; proofName: string };

  if (!proofData) { res.status(400).json({ error: "No proof data provided" }); return; }
  if (!proofData.startsWith("data:image/")) { res.status(400).json({ error: "Only image files are accepted" }); return; }
  // Limit to ~5MB of base64 data
  if (proofData.length > 7_000_000) { res.status(400).json({ error: "Image too large. Please compress and try again." }); return; }

  const fee = await db.query.feesTable.findFirst({ where: eq(feesTable.id, feeId) });
  if (!fee) { res.status(404).json({ error: "Fee not found" }); return; }
  if (fee.status === "paid") { res.status(400).json({ error: "This challan is already paid" }); return; }

  await db.update(feesTable).set({
    paymentProofData: proofData,
    paymentProofName: proofName || "payment_proof.jpg",
    updatedAt: new Date(),
  }).where(eq(feesTable.id, feeId));

  // Notify admin that proof was submitted
  const months = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  await sendFeeNotification(
    fee.schoolId, fee.studentId,
    `Payment Proof Submitted — ${months[fee.month]} ${fee.year}`,
    `Payment proof has been uploaded for challan ${fee.challanNumber || `#${fee.id}`} (${months[fee.month]} ${fee.year}). Please verify and update the payment status.`,
    "info",
  );

  res.json({ success: true, message: "Payment proof uploaded successfully" });
});

// ─── GET /:feeId/proof ────────────────────────────────────────────────────────
// Admin views the payment proof image

router.get("/:feeId/proof", requireAuth, requireRole("super_admin", "admin", "accountant", "sub_admin"), async (req, res) => {
  const feeId = Number(req.params.feeId);
  const fee = await db.query.feesTable.findFirst({ where: eq(feesTable.id, feeId) });

  if (!fee) { res.status(404).json({ error: "Not found" }); return; }
  if (!fee.paymentProofData) { res.status(404).json({ error: "No proof uploaded for this challan" }); return; }

  res.json({
    proofData: fee.paymentProofData,
    proofName: fee.paymentProofName,
  });
});

// ─── POST /:feeId/verify ──────────────────────────────────────────────────────
// Admin verifies proof and marks as paid

router.post("/:feeId/verify", requireAuth, requireRole("super_admin", "admin", "accountant", "sub_admin"), async (req, res) => {
  const feeId = Number(req.params.feeId);
  const { paymentMethod = "online" } = req.body;

  const fee = await db.query.feesTable.findFirst({ where: eq(feesTable.id, feeId) });
  if (!fee) { res.status(404).json({ error: "Fee not found" }); return; }
  if (fee.status === "paid") { res.status(400).json({ error: "Already paid" }); return; }

  const [updated] = await db.update(feesTable).set({
    status: "paid",
    paidAmount: fee.amount,
    paidDate: new Date().toISOString().split("T")[0],
    paymentMethod,
    paymentProofData: null,
    paymentProofName: null,
    updatedAt: new Date(),
  }).where(eq(feesTable.id, feeId)).returning();

  const months = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  await sendFeeNotification(
    fee.schoolId, fee.studentId,
    `Payment Verified — ${months[fee.month]} ${fee.year}`,
    `Your payment for ${months[fee.month]} ${fee.year} (Challan: ${fee.challanNumber || `#${fee.id}`}) has been verified and confirmed. Amount: Rs. ${parseFloat(fee.amount as string).toLocaleString()}. Thank you!`,
    "success",
  );

  res.json(updated);
});

export default router;
