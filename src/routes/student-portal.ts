import { Router } from "express";
import {
  db,
  studentsTable,
  attendanceTable,
  feesTable,
  resultsTable,
  examsTable,
  assignmentsTable,
  notificationsTable,
  classesTable,
  schoolsTable,
} from "@workspace/db";
import { eq, and, or, isNull, desc, asc, gte, lte, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth.js";

const router = Router();

// All student portal routes require the student role
router.use(requireAuth);

// Get student's own profile (linked via userId)
router.get("/me", async (req, res) => {
  const student = await db.query.studentsTable.findFirst({
    where: eq(studentsTable.userId, req.user!.id),
  });
  if (!student) {
    res.status(404).json({ error: "Not Found", message: "Student profile not found" });
    return;
  }

  const [cls, school] = await Promise.all([
    student.classId
      ? db.query.classesTable.findFirst({ where: eq(classesTable.id, student.classId) })
      : Promise.resolve(null),
    student.schoolId
      ? db.query.schoolsTable.findFirst({ where: eq(schoolsTable.id, student.schoolId) })
      : Promise.resolve(null),
  ]);

  res.json({ ...student, class: cls, school });
});

// Student dashboard overview
router.get("/dashboard", async (req, res) => {
  const student = await db.query.studentsTable.findFirst({
    where: eq(studentsTable.userId, req.user!.id),
  });
  if (!student) {
    res.status(404).json({ error: "Not Found", message: "Student profile not found" });
    return;
  }

  // Attendance summary (last 30 days)
  const attendance = await db.select()
    .from(attendanceTable)
    .where(eq(attendanceTable.studentId, student.id))
    .orderBy(desc(attendanceTable.date))
    .limit(30);

  const presentDays = attendance.filter((a) => a.status === "present").length;
  const absentDays = attendance.filter((a) => a.status === "absent").length;
  const lateDays = attendance.filter((a) => a.status === "late").length;
  const attendancePct = attendance.length > 0 ? Math.round((presentDays / attendance.length) * 100) : 0;

  // Pending fees
  const pendingFees = await db.select()
    .from(feesTable)
    .where(and(eq(feesTable.studentId, student.id), eq(feesTable.status, "unpaid")))
    .orderBy(desc(feesTable.createdAt))
    .limit(5);

  const overdueFees = await db.select()
    .from(feesTable)
    .where(and(eq(feesTable.studentId, student.id), eq(feesTable.status, "overdue")))
    .limit(5);

  // Recent results
  const recentResults = await db.select({
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
    .limit(5);

  // Upcoming assignments
  const assignments = student.classId
    ? await db.select({
        id: assignmentsTable.id,
        title: assignmentsTable.title,
        description: assignmentsTable.description,
        type: assignmentsTable.type,
        dueDate: assignmentsTable.dueDate,
        fileName: assignmentsTable.fileName,
        fileType: assignmentsTable.fileType,
        createdAt: assignmentsTable.createdAt,
      })
        .from(assignmentsTable)
        .where(and(eq(assignmentsTable.classId, student.classId!), eq(assignmentsTable.isPublished, true)))
        .orderBy(desc(assignmentsTable.createdAt))
        .limit(5)
    : [];

  // All notifications relevant to this student:
  // 1. Targeted by recipientUserId (new — uses users.id)
  // 2. Targeted by targetStudentId (legacy — uses students.id)
  // 3. Broadcast to the "student" role
  // 4. School-wide broadcast (no targeting)
  const allNotifications = await db.select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.schoolId, student.schoolId),
        or(
          eq(notificationsTable.recipientUserId, req.user!.id),
          eq(notificationsTable.targetStudentId, student.id),
          eq(notificationsTable.targetRole, "student"),
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
    student,
    attendance: {
      recent: attendance,
      presentDays,
      absentDays,
      lateDays,
      attendancePct,
    },
    fees: {
      pending: pendingFees,
      overdue: overdueFees,
      totalPending: pendingFees.length + overdueFees.length,
    },
    recentResults,
    assignments,
    notifications: allNotifications,
  });
});

// Student's assignments
router.get("/assignments", async (req, res) => {
  const student = await db.query.studentsTable.findFirst({
    where: eq(studentsTable.userId, req.user!.id),
  });
  if (!student || !student.classId) {
    res.json([]);
    return;
  }

  const raw = await db.select({
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
    .where(and(eq(assignmentsTable.classId, student.classId), eq(assignmentsTable.isPublished, true)))
    .orderBy(desc(assignmentsTable.createdAt));

  const assignments = raw.map(a => ({
    ...a,
    files: (() => { try { return a.filesJson ? JSON.parse(a.filesJson) : []; } catch { return []; } })(),
    progress: (() => { try { return a.progressJson ? JSON.parse(a.progressJson) : []; } catch { return []; } })(),
  }));

  res.json(assignments);
});

// Download assignment file
router.get("/assignments/:id/file", async (req, res) => {
  const assignment = await db.query.assignmentsTable.findFirst({
    where: eq(assignmentsTable.id, Number(req.params.id)),
  });
  if (!assignment || !assignment.fileBase64) {
    res.status(404).json({ error: "No file attached" });
    return;
  }
  res.json({ fileBase64: assignment.fileBase64, fileName: assignment.fileName, fileType: assignment.fileType });
});

// Student's fees (full detail)
router.get("/fees", async (req, res) => {
  const student = await db.query.studentsTable.findFirst({
    where: eq(studentsTable.userId, req.user!.id),
  });
  if (!student) { res.json([]); return; }

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
    .where(eq(feesTable.studentId, student.id))
    .orderBy(desc(feesTable.year), desc(feesTable.month));

  res.json(fees);
});

// Student's attendance
router.get("/attendance", async (req, res) => {
  const student = await db.query.studentsTable.findFirst({
    where: eq(studentsTable.userId, req.user!.id),
  });
  if (!student) { res.json({ records: [], student: null }); return; }

  const { from, to } = req.query as Record<string, string>;
  const conditions: any[] = [eq(attendanceTable.studentId, student.id)];
  if (from) conditions.push(sql`${attendanceTable.date} >= ${from}::date`);
  if (to)   conditions.push(sql`${attendanceTable.date} <= ${to}::date`);

  const attendance = await db.select({
    id: attendanceTable.id,
    studentId: attendanceTable.studentId,
    date: sql<string>`to_char(${attendanceTable.date}, 'YYYY-MM-DD')`,
    status: attendanceTable.status,
    remarks: attendanceTable.remarks,
    scanTime: sql<string | null>`null`,
  })
    .from(attendanceTable)
    .where(and(...conditions))
    .orderBy(desc(attendanceTable.date))
    .limit(400);

  // Summary counts
  const present = attendance.filter(r => r.status === "present").length;
  const late    = attendance.filter(r => r.status === "late").length;
  const absent  = attendance.filter(r => r.status === "absent").length;
  const leave   = attendance.filter(r => r.status === "leave").length;
  const total   = present + late + absent + leave;
  const pct     = total > 0 ? Math.round(((present + late) / total) * 100) : 0;

  res.json({
    records: attendance,
    student: { id: student.id, name: student.name, admissionNumber: student.admissionNumber, classId: student.classId },
    summary: { present, late, absent, leave, total, pct },
  });
});

// Student's results
router.get("/results", async (req, res) => {
  const student = await db.query.studentsTable.findFirst({
    where: eq(studentsTable.userId, req.user!.id),
  });
  if (!student) { res.json([]); return; }

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
    .orderBy(desc(examsTable.examDate));

  res.json(results);
});

// Student's notifications
router.get("/notifications", async (req, res) => {
  const student = await db.query.studentsTable.findFirst({
    where: eq(studentsTable.userId, req.user!.id),
  });
  if (!student) { res.json([]); return; }

  const personal = await db.select()
    .from(notificationsTable)
    .where(and(eq(notificationsTable.schoolId, student.schoolId), eq(notificationsTable.targetStudentId, student.id)))
    .orderBy(desc(notificationsTable.createdAt));

  const general = await db.select()
    .from(notificationsTable)
    .where(and(eq(notificationsTable.schoolId, student.schoolId), eq(notificationsTable.targetRole, "student")))
    .orderBy(desc(notificationsTable.createdAt))
    .limit(10);

  const all = [...personal, ...general].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  res.json(all);
});

// Mark notification as read
router.put("/notifications/:id/read", async (req, res) => {
  await db.update(notificationsTable).set({ isRead: true }).where(eq(notificationsTable.id, Number(req.params.id)));
  res.json({ success: true });
});

// ── Date Sheet — upcoming & all exams for student's class ─────────────────────
router.get("/datesheet", async (req, res) => {
  const student = await db.query.studentsTable.findFirst({
    where: eq(studentsTable.userId, req.user!.id),
  });
  if (!student?.classId) {
    res.json({ exams: [] });
    return;
  }

  const session  = req.query.session  as string | undefined;
  const subject  = req.query.subject  as string | undefined;
  const examType = req.query.examType as string | undefined;
  const upcoming = req.query.upcoming === "true";

  const conds: any[] = [eq(examsTable.classId, student.classId)];
  if (session)   conds.push(eq(examsTable.session,  session));
  if (examType)  conds.push(eq(examsTable.examType, examType));
  if (subject)   conds.push(sql`LOWER(TRIM(${examsTable.subject})) = ${subject.toLowerCase()}`);
  if (upcoming)  conds.push(sql`${examsTable.examDate} >= CURRENT_DATE`);

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

  res.json({ exams, classId: student.classId });
});

// ── POST /api/student/face — Student self-enrolls their own face ───────────────
router.post("/face", async (req, res) => {
  const { descriptor } = req.body;
  if (!descriptor || !Array.isArray(descriptor)) {
    res.status(400).json({ error: "descriptor array required" });
    return;
  }

  const student = await db.query.studentsTable.findFirst({
    where: eq(studentsTable.userId, req.user!.id),
  });
  if (!student) {
    res.status(404).json({ error: "Student profile not found" });
    return;
  }

  // Check if school allows self-enrollment
  if (student.schoolId) {
    const school = await db.query.schoolsTable.findFirst({ where: eq(schoolsTable.id, student.schoolId) });
    if (!school?.allowSelfFaceEnrollment) {
      res.status(403).json({ error: "Self face enrollment is not enabled by admin" });
      return;
    }
  }

  await db.update(studentsTable)
    .set({ faceDescriptor: JSON.stringify(descriptor), updatedAt: new Date() })
    .where(eq(studentsTable.id, student.id));

  res.json({ success: true, message: "Face enrolled successfully" });
});

// ── DELETE /api/student/face — Student removes their own face ─────────────────
router.delete("/face", async (req, res) => {
  const student = await db.query.studentsTable.findFirst({
    where: eq(studentsTable.userId, req.user!.id),
  });
  if (!student) {
    res.status(404).json({ error: "Student profile not found" });
    return;
  }

  await db.update(studentsTable)
    .set({ faceDescriptor: null, updatedAt: new Date() })
    .where(eq(studentsTable.id, student.id));

  res.json({ success: true });
});

export default router;
