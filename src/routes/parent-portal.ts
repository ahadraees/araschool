import { Router } from "express";
import {
  db,
  studentsTable,
  parentStudentsTable,
  attendanceTable,
  feesTable,
  resultsTable,
  examsTable,
  assignmentsTable,
  notificationsTable,
  classesTable,
  schoolsTable,
} from "@workspace/db";
import { eq, and, or, isNull, desc, sql, gte, lte } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

router.use(requireAuth);

// Get parent's children list
router.get("/children", async (req, res) => {
  const links = await db.select()
    .from(parentStudentsTable)
    .where(eq(parentStudentsTable.parentUserId, req.user!.id));

  if (links.length === 0) {
    res.json([]);
    return;
  }

  const studentIds = links.map((l) => l.studentId);
  const children = await Promise.all(
    studentIds.map(async (id) => {
      const student = await db.query.studentsTable.findFirst({ where: eq(studentsTable.id, id) });
      if (!student) return null;
      const cls = student.classId
        ? await db.query.classesTable.findFirst({ where: eq(classesTable.id, student.classId) })
        : null;
      return { ...student, class: cls };
    })
  );

  res.json(children.filter(Boolean));
});

// Parent dashboard — summary for a specific child
router.get("/dashboard/:studentId", async (req, res) => {
  const studentId = Number(req.params.studentId);

  // Verify parent is linked to this student
  const link = await db.query.parentStudentsTable.findFirst({
    where: and(
      eq(parentStudentsTable.parentUserId, req.user!.id),
      eq(parentStudentsTable.studentId, studentId),
    ),
  });

  if (!link) {
    res.status(403).json({ error: "Forbidden", message: "Not authorized to view this student" });
    return;
  }

  const student = await db.query.studentsTable.findFirst({ where: eq(studentsTable.id, studentId) });
  if (!student) {
    res.status(404).json({ error: "Not Found" });
    return;
  }

  const cls = student.classId
    ? await db.query.classesTable.findFirst({ where: eq(classesTable.id, student.classId) })
    : null;

  // Attendance
  const attendance = await db.select()
    .from(attendanceTable)
    .where(eq(attendanceTable.studentId, student.id))
    .orderBy(desc(attendanceTable.date))
    .limit(30);

  const presentDays = attendance.filter((a) => a.status === "present").length;
  const absentDays = attendance.filter((a) => a.status === "absent").length;
  const lateDays = attendance.filter((a) => a.status === "late").length;
  const attendancePct = attendance.length > 0 ? Math.round((presentDays / attendance.length) * 100) : 0;

  // Fees
  const fees = await db.select()
    .from(feesTable)
    .where(eq(feesTable.studentId, student.id))
    .orderBy(desc(feesTable.year), desc(feesTable.month))
    .limit(12);

  const pendingFees = fees.filter((f) => f.status === "unpaid" || f.status === "overdue" || f.status === "partial");

  // Results / Progress
  const results = await db.select({
    id: resultsTable.id,
    marksObtained: resultsTable.marksObtained,
    grade: resultsTable.grade,
    remarks: resultsTable.remarks,
    examName: examsTable.name,
    examSubject: examsTable.subject,
    totalMarks: examsTable.totalMarks,
    passingMarks: examsTable.passingMarks,
    examDate: examsTable.examDate,
  })
    .from(resultsTable)
    .innerJoin(examsTable, eq(resultsTable.examId, examsTable.id))
    .where(eq(resultsTable.studentId, student.id))
    .orderBy(desc(examsTable.examDate))
    .limit(10);

  // Upcoming assignments
  const rawAssignments = student.classId
    ? await db.select({
        id: assignmentsTable.id,
        title: assignmentsTable.title,
        description: assignmentsTable.description,
        content: assignmentsTable.content,
        fileName: assignmentsTable.fileName,
        fileType: assignmentsTable.fileType,
        filesJson: assignmentsTable.filesJson,
        progressJson: assignmentsTable.progressJson,
        type: assignmentsTable.type,
        dueDate: assignmentsTable.dueDate,
        createdAt: assignmentsTable.createdAt,
      })
        .from(assignmentsTable)
        .where(and(eq(assignmentsTable.classId, student.classId!), eq(assignmentsTable.isPublished, true)))
        .orderBy(desc(assignmentsTable.createdAt))
        .limit(8)
    : [];
  const assignments = rawAssignments.map(a => ({
    ...a,
    files: (() => { try { return a.filesJson ? JSON.parse(a.filesJson) : []; } catch { return []; } })(),
    progress: (() => { try { return a.progressJson ? JSON.parse(a.progressJson) : []; } catch { return []; } })(),
  }));

  // All notifications for the parent:
  // 1. Targeted directly at this parent by recipientUserId (users.id)
  // 2. Targeted at the child by targetStudentId (students.id, legacy)
  // 3. Broadcast to all parents by targetRole
  // 4. School-wide broadcast (no targeting)
  const allNotifications = await db.select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.schoolId, student.schoolId),
        or(
          eq(notificationsTable.recipientUserId, req.user!.id),
          eq(notificationsTable.targetStudentId, student.id),
          eq(notificationsTable.targetRole, "parent"),
          and(
            isNull(notificationsTable.targetRole),
            isNull(notificationsTable.recipientUserId),
          ),
        ),
      )
    )
    .orderBy(desc(notificationsTable.createdAt))
    .limit(20);

  res.json({
    student: { ...student, class: cls },
    attendance: { recent: attendance.slice(0, 10), presentDays, absentDays, lateDays, attendancePct },
    fees: { all: fees, pending: pendingFees },
    results,
    assignments,
    notifications: allNotifications,
  });
});

// Parent — detailed attendance for a specific child with date range + summary
router.get("/attendance/:studentId", async (req, res) => {
  const studentId = Number(req.params.studentId);
  const { from, to } = req.query as Record<string, string>;

  const link = await db.query.parentStudentsTable.findFirst({
    where: and(eq(parentStudentsTable.parentUserId, req.user!.id), eq(parentStudentsTable.studentId, studentId)),
  });
  if (!link) { res.status(403).json({ error: "Forbidden" }); return; }

  const student = await db.query.studentsTable.findFirst({ where: eq(studentsTable.id, studentId) });
  if (!student) { res.status(404).json({ error: "Not Found" }); return; }

  const conditions: any[] = [eq(attendanceTable.studentId, studentId)];
  if (from) conditions.push(sql`${attendanceTable.date} >= ${from}::date`);
  if (to)   conditions.push(sql`${attendanceTable.date} <= ${to}::date`);

  const records = await db.select({
    id:       attendanceTable.id,
    date:     sql<string>`to_char(${attendanceTable.date}, 'YYYY-MM-DD')`,
    status:   attendanceTable.status,
    remarks:  attendanceTable.remarks,
  }).from(attendanceTable)
    .where(and(...conditions))
    .orderBy(desc(attendanceTable.date))
    .limit(400);

  const present = records.filter(r => r.status === "present").length;
  const late    = records.filter(r => r.status === "late").length;
  const absent  = records.filter(r => r.status === "absent").length;
  const leave   = records.filter(r => r.status === "leave").length;
  const total   = present + late + absent + leave;
  const pct     = total > 0 ? Math.round(((present + late) / total) * 100) : 0;

  res.json({
    records,
    student: { id: student.id, name: student.name, admissionNumber: student.admissionNumber, classId: student.classId },
    summary: { present, late, absent, leave, total, pct },
  });
});

// All fees for a specific child (parent view)
router.get("/fees/:studentId", async (req, res) => {
  const studentId = Number(req.params.studentId);

  // Verify parent is linked to this student
  const link = await db.query.parentStudentsTable.findFirst({
    where: and(
      eq(parentStudentsTable.parentUserId, req.user!.id),
      eq(parentStudentsTable.studentId, studentId),
    ),
  });

  if (!link) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

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
      createdAt: feesTable.createdAt,
      studentName: studentsTable.name,
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
    .where(eq(feesTable.studentId, studentId))
    .orderBy(desc(feesTable.year), desc(feesTable.month));

  res.json(fees);
});

// ── Date Sheet — all exams for parent's linked student(s) ────────────────────
router.get("/datesheet/:studentId", async (req, res) => {
  const studentId = Number(req.params.studentId);
  const link = await db.query.parentStudentsTable.findFirst({
    where: and(eq(parentStudentsTable.parentUserId, req.user!.id), eq(parentStudentsTable.studentId, studentId)),
  });
  if (!link) { res.status(403).json({ error: "Forbidden" }); return; }

  const student = await db.query.studentsTable.findFirst({ where: eq(studentsTable.id, studentId) });
  if (!student?.classId) { res.json({ exams: [] }); return; }

  const session  = req.query.session  as string | undefined;
  const subject  = req.query.subject  as string | undefined;
  const examType = req.query.examType as string | undefined;
  const upcoming = req.query.upcoming === "true";

  const { asc, sql: dsql } = await import("drizzle-orm");
  const conds: any[] = [eq(examsTable.classId, student.classId)];
  if (session)   conds.push(eq(examsTable.session,  session));
  if (examType)  conds.push(eq(examsTable.examType, examType));
  if (subject)   conds.push(dsql`LOWER(TRIM(${examsTable.subject})) = ${subject.toLowerCase()}`);
  if (upcoming)  conds.push(dsql`${examsTable.examDate} >= CURRENT_DATE`);

  const exams = await db
    .select({
      id:           examsTable.id,
      name:         examsTable.name,
      subject:      examsTable.subject,
      examDate:     examsTable.examDate,
      startTime:    examsTable.startTime,
      endTime:      examsTable.endTime,
      venue:        examsTable.venue,
      totalMarks:   examsTable.totalMarks,
      passingMarks: examsTable.passingMarks,
      examType:     examsTable.examType,
      session:      examsTable.session,
      status:       examsTable.status,
      description:  examsTable.description,
      className:    classesTable.name,
      classSection: classesTable.section,
    })
    .from(examsTable)
    .leftJoin(classesTable, eq(examsTable.classId, classesTable.id))
    .where(and(...conds))
    .orderBy(asc(examsTable.examDate), asc(examsTable.startTime));

  res.json({ exams, student: { id: student.id, name: student.name, classId: student.classId } });
});

export default router;
