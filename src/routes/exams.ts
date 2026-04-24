import { Router } from "express";
import { db, examsTable, resultsTable, studentsTable, classesTable, teachersTable, recheckRequestsTable, examAuditLogsTable, usersTable, teacherClassesTable, classTermPermissionsTable, notificationsTable, parentStudentsTable, smsSettingsTable } from "@workspace/db";
import { eq, and, or, desc, asc, sql, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { normalizeSubject } from "../lib/normalize.js";
import { sendSmsOrWhatsapp } from "./sms-settings.js";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────
function calcGrade(pct: number): string {
  if (pct >= 90) return "A+";
  if (pct >= 80) return "A";
  if (pct >= 70) return "B";
  if (pct >= 60) return "C";
  if (pct >= 50) return "D";
  return "F";
}

async function logAudit(data: {
  schoolId: number; examId: number; studentId?: number;
  changedByUserId: number; action: string; oldValue?: string; newValue?: string; note?: string;
}) {
  await db.insert(examAuditLogsTable).values(data).catch(() => {});
}

// ── Exam Types (static list) ───────────────────────────────────────────────────
router.get("/types", requireAuth, (_req, res) => {
  res.json([
    { value: "daily_test",  label: "Daily Test",   icon: "📝" },
    { value: "weekly_test", label: "Weekly Test",  icon: "📆" },
    { value: "monthly",     label: "Monthly Test", icon: "📅" },
    { value: "mid_term",    label: "Mid Term",     icon: "📖" },
    { value: "final_term",  label: "Final Term",   icon: "🎓" },
    { value: "annual",      label: "Annual Exam",  icon: "🏆" },
    { value: "class_test",  label: "Class Test",   icon: "✏️" },
    { value: "quiz",        label: "Quiz",         icon: "❓" },
    { value: "assignment",  label: "Assignment",   icon: "📋" },
  ]);
});

// ── List Exams ─────────────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  const classId  = req.query.classId  ? Number(req.query.classId)  : undefined;
  const schoolId = req.query.schoolId ? Number(req.query.schoolId) : req.user!.schoolId;
  const session  = req.query.session  as string | undefined;
  const examType = req.query.examType as string | undefined;
  const status   = req.query.status   as string | undefined;

  const conds: any[] = [];
  if (schoolId)  conds.push(eq(examsTable.schoolId, schoolId));
  if (classId)   conds.push(eq(examsTable.classId,  classId));
  if (session)   conds.push(eq(examsTable.session,  session));
  if (examType)  conds.push(eq(examsTable.examType, examType));
  if (status)    conds.push(eq(examsTable.status,   status));

  // ── Teacher subject+class filter (Marks Entry) ────────────────────────────
  // Teachers only see exams matching their assigned (classId + subject) pairs.
  // If an assignment row has NO subject, match by classId alone (legacy data).
  // If teacher has no assignments at all, they see all school exams (fallback).
  if (req.user!.role === "teacher") {
    const teacher = await db.select({ id: teachersTable.id, subject: teachersTable.subject })
      .from(teachersTable).where(eq(teachersTable.userId, req.user!.id)).limit(1);
    if (teacher[0]) {
      const tcRows = await db
        .select({ classId: teacherClassesTable.classId, subject: teacherClassesTable.subject })
        .from(teacherClassesTable)
        .where(eq(teacherClassesTable.teacherId, teacher[0].id));

      if (tcRows.length > 0) {
        // Deduplicate by classId so each class appears once
        const uniqueByClass = Array.from(
          new Map(tcRows.map(r => [r.classId, r])).values()
        );
        const hasSubjects = uniqueByClass.some(r => r.subject?.trim());
        if (hasSubjects) {
          // Build per-assignment (classId AND subject) OR conditions.
          // Use LOWER(TRIM()) on both sides — case-insensitive match
          // e.g. assignment "chemistry" matches exam "Chemistry"
          const orConds = uniqueByClass.map(r => {
            const subj = r.subject?.trim().toLowerCase();
            return subj
              ? and(
                  eq(examsTable.classId, r.classId!),
                  sql`LOWER(TRIM(${examsTable.subject})) = ${subj}`,
                )
              : eq(examsTable.classId, r.classId!);
          });
          conds.push(or(...orConds as any[]));
        } else {
          // No subjects assigned — filter by classIds only
          conds.push(inArray(examsTable.classId, uniqueByClass.map(r => r.classId!)));
        }
      }
    }
  }

  const exams = await db
    .select({
      id: examsTable.id, schoolId: examsTable.schoolId, classId: examsTable.classId,
      name: examsTable.name, subject: examsTable.subject,
      totalMarks: examsTable.totalMarks, passingMarks: examsTable.passingMarks,
      examDate: examsTable.examDate, examType: examsTable.examType,
      session: examsTable.session, status: examsTable.status,
      startTime: examsTable.startTime, endTime: examsTable.endTime,
      venue: examsTable.venue, marksStatus: examsTable.marksStatus,
      description: examsTable.description, publishedAt: examsTable.publishedAt,
      resultPublishDate: examsTable.resultPublishDate,
      createdAt: examsTable.createdAt, updatedAt: examsTable.updatedAt,
      className: classesTable.name, classSection: classesTable.section,
    })
    .from(examsTable)
    .leftJoin(classesTable, eq(examsTable.classId, classesTable.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(examsTable.createdAt));

  // ── Auto-publish: if resultPublishDate <= today and marks submitted, auto publish ──
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const toAutoPublish = exams.filter(e =>
    e.resultPublishDate &&
    new Date(e.resultPublishDate) <= today &&
    e.status !== "published" &&
    e.marksStatus === "submitted"
  );
  if (toAutoPublish.length > 0) {
    await db.update(examsTable)
      .set({ status: "published", publishedAt: new Date(), updatedAt: new Date() })
      .where(and(
        inArray(examsTable.id, toAutoPublish.map(e => e.id)),
        eq(examsTable.marksStatus, "submitted")
      ));
    toAutoPublish.forEach(e => { e.status = "published"; e.publishedAt = new Date(); });
  }

  res.json(exams);
});

// ── Class-wide Student Performance (for weak subject detection) ────────────────
router.get("/class-analysis", requireAuth, async (req, res) => {
  const classId  = req.query.classId  ? Number(req.query.classId)  : undefined;
  const session  = req.query.session  as string | undefined;
  const schoolId = req.user!.schoolId!;

  // Get all exams for this class
  const examConds: any[] = [eq(examsTable.schoolId, schoolId)];
  if (classId) examConds.push(eq(examsTable.classId, classId));
  if (session)  examConds.push(eq(examsTable.session, session));

  const exams = await db.select().from(examsTable).where(and(...examConds));
  if (exams.length === 0) { res.json({ students: [], subjects: [], exams: [] }); return; }

  const examIds = exams.map(e => e.id);

  // Get all results for those exams
  const results = await db
    .select({
      studentId: resultsTable.studentId,
      examId: resultsTable.examId,
      marksObtained: resultsTable.marksObtained,
      percentage: resultsTable.percentage,
      grade: resultsTable.grade,
      isAbsent: resultsTable.isAbsent,
      studentName: studentsTable.name,
      rollNumber: studentsTable.rollNumber,
      subject: examsTable.subject,
      totalMarks: examsTable.totalMarks,
      passingMarks: examsTable.passingMarks,
      examType: examsTable.examType,
      examName: examsTable.name,
      examDate: examsTable.examDate,
    })
    .from(resultsTable)
    .leftJoin(studentsTable, eq(resultsTable.studentId, studentsTable.id))
    .leftJoin(examsTable, eq(resultsTable.examId, examsTable.id))
    .where(inArray(resultsTable.examId, examIds));

  // Build student → subject → [percentages] map
  const studentMap: Record<number, { name: string; rollNumber?: string; subjects: Record<string, number[]> }> = {};
  const allSubjects = new Set<string>();

  for (const r of results) {
    if (r.isAbsent) continue;
    const pct = parseFloat(r.percentage as string || "0");
    const sub = r.subject ?? "Unknown";
    allSubjects.add(sub);

    if (!studentMap[r.studentId]) {
      studentMap[r.studentId] = { name: r.studentName ?? "Student", rollNumber: r.rollNumber ?? undefined, subjects: {} };
    }
    if (!studentMap[r.studentId].subjects[sub]) studentMap[r.studentId].subjects[sub] = [];
    studentMap[r.studentId].subjects[sub].push(pct);
  }

  // Compute per-student averages and flag weak subjects
  const subjects = Array.from(allSubjects).sort();
  const students = Object.entries(studentMap).map(([idStr, data]) => {
    const subjectAverages: Record<string, number> = {};
    const weakSubjects: string[] = [];
    for (const sub of subjects) {
      const pcts = data.subjects[sub] ?? [];
      const avg = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;
      if (avg !== null) {
        subjectAverages[sub] = avg;
        if (avg < 50) weakSubjects.push(sub);
      }
    }
    const allPcts = Object.values(subjectAverages);
    const overallAvg = allPcts.length ? Math.round(allPcts.reduce((a, b) => a + b, 0) / allPcts.length) : 0;
    return {
      studentId: Number(idStr),
      name: data.name,
      rollNumber: data.rollNumber,
      subjectAverages,
      weakSubjects,
      overallAvg,
    };
  }).sort((a, b) => b.overallAvg - a.overallAvg);

  res.json({ students, subjects, examCount: exams.length });
});

// ── Marks Sheet: All students in exam's class + existing results merged ────────
router.get("/marks-sheet/:examId", requireAuth, async (req, res) => {
  const examId = Number(req.params.examId);
  if (isNaN(examId)) { res.status(400).json({ error: "Invalid examId" }); return; }

  const exam = await db.query.examsTable.findFirst({ where: eq(examsTable.id, examId) });
  if (!exam) { res.status(404).json({ error: "Exam not found" }); return; }

  const students = await db
    .select({ id: studentsTable.id, name: studentsTable.name, rollNumber: studentsTable.rollNumber })
    .from(studentsTable)
    .where(and(eq(studentsTable.classId, exam.classId), eq(studentsTable.isActive, true)))
    .orderBy(asc(studentsTable.rollNumber));

  const results = await db.select().from(resultsTable).where(eq(resultsTable.examId, examId));
  const resultMap = new Map(results.map(r => [r.studentId, r]));

  const sheet = students.map(s => {
    const r = resultMap.get(s.id);
    const marks = r?.marksObtained ? parseFloat(r.marksObtained as string) : null;
    const pct   = marks !== null ? ((marks / exam.totalMarks) * 100) : null;
    return {
      studentId:     s.id,
      name:          s.name,
      rollNumber:    s.rollNumber,
      marksObtained: marks,
      percentage:    pct !== null ? pct.toFixed(2) : null,
      grade:         r?.grade ?? null,
      isAbsent:      r?.isAbsent ?? false,
      remarks:       r?.remarks ?? "",
      position:      r?.position ?? null,
    };
  });

  res.json(sheet);
});

// ── Results (GET) — MUST be before /:examId ───────────────────────────────────
router.get("/results", requireAuth, async (req, res) => {
  const examId    = req.query.examId    ? Number(req.query.examId)    : undefined;
  const studentId = req.query.studentId ? Number(req.query.studentId) : undefined;
  const classId   = req.query.classId   ? Number(req.query.classId)   : undefined;
  const schoolId  = req.query.schoolId  ? Number(req.query.schoolId)  : req.user!.schoolId;

  const conds: any[] = [];
  if (examId)    conds.push(eq(resultsTable.examId, examId));
  if (studentId) conds.push(eq(resultsTable.studentId, studentId));

  const results = await db
    .select({
      id: resultsTable.id, examId: resultsTable.examId, studentId: resultsTable.studentId,
      marksObtained: resultsTable.marksObtained, grade: resultsTable.grade,
      percentage: resultsTable.percentage, position: resultsTable.position,
      isAbsent: resultsTable.isAbsent, isDraft: resultsTable.isDraft,
      remarks: resultsTable.remarks, createdAt: resultsTable.createdAt,
      studentName: studentsTable.name, rollNumber: studentsTable.rollNumber,
      examName: examsTable.name, subject: examsTable.subject,
      totalMarks: examsTable.totalMarks, passingMarks: examsTable.passingMarks,
      examDate: examsTable.examDate, examType: examsTable.examType,
      examStatus: examsTable.status,
      className: classesTable.name,
    })
    .from(resultsTable)
    .leftJoin(studentsTable, eq(resultsTable.studentId, studentsTable.id))
    .leftJoin(examsTable, eq(resultsTable.examId, examsTable.id))
    .leftJoin(classesTable, eq(examsTable.classId, classesTable.id))
    .where(conds.length ? and(...conds) : undefined);

  let enriched = results.map(r => ({
    ...r,
    percentage: r.percentage ?? (r.totalMarks ? ((parseFloat(r.marksObtained as string) / r.totalMarks) * 100).toFixed(2) : 0),
  }));

  if (classId) {
    const classStudents = await db.select({ id: studentsTable.id })
      .from(studentsTable).where(eq(studentsTable.classId, classId));
    const classStudentIds = new Set(classStudents.map(s => s.id));
    enriched = enriched.filter(r => classStudentIds.has(r.studentId));
  }

  if (schoolId && !examId) {
    const schoolExams = await db.select({ id: examsTable.id })
      .from(examsTable).where(eq(examsTable.schoolId, schoolId));
    const examIds = new Set(schoolExams.map(e => e.id));
    enriched = enriched.filter(r => examIds.has(r.examId));
  }

  res.json(enriched);
});

// ── Teacher Performance: class-wise exam stats ────────────────────────────────
router.get("/teacher-performance", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const teacherIdParam = req.query.teacherId ? Number(req.query.teacherId) : undefined;

  // If teacher filter requested, find their assigned classes first
  let allowedClassIds: number[] | null = null;
  if (teacherIdParam) {
    const teacherClasses = await db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(and(eq(classesTable.schoolId, schoolId), eq(classesTable.teacherId, teacherIdParam)));
    allowedClassIds = teacherClasses.map(c => c.id);
    if (allowedClassIds.length === 0) { res.json([]); return; }
  }

  const examConds: any[] = [eq(examsTable.schoolId, schoolId)];
  if (allowedClassIds) examConds.push(inArray(examsTable.classId, allowedClassIds));

  const exams = await db
    .select({
      id: examsTable.id, name: examsTable.name, subject: examsTable.subject,
      classId: examsTable.classId, className: classesTable.name, classSection: classesTable.section,
      teacherId: classesTable.teacherId,
      totalMarks: examsTable.totalMarks, passingMarks: examsTable.passingMarks,
      status: examsTable.status, marksStatus: examsTable.marksStatus,
      description: examsTable.description, session: examsTable.session,
    })
    .from(examsTable)
    .leftJoin(classesTable, eq(examsTable.classId, classesTable.id))
    .where(examConds.length ? and(...examConds) : undefined);

  const allResults = await db
    .select({
      examId: resultsTable.examId, studentId: resultsTable.studentId,
      marksObtained: resultsTable.marksObtained, percentage: resultsTable.percentage,
      isAbsent: resultsTable.isAbsent, grade: resultsTable.grade,
    })
    .from(resultsTable)
    .leftJoin(examsTable, eq(resultsTable.examId, examsTable.id))
    .where(eq(examsTable.schoolId, schoolId));

  // Group by class
  const byClass: Record<number, {
    className: string; section?: string; exams: typeof exams; results: typeof allResults;
  }> = {};

  for (const exam of exams) {
    if (!exam.classId) continue;
    if (!byClass[exam.classId]) byClass[exam.classId] = { className: exam.className ?? "", section: exam.classSection ?? "", exams: [], results: [] };
    byClass[exam.classId].exams.push(exam);
  }
  for (const r of allResults) {
    const exam = exams.find(e => e.id === r.examId);
    if (exam?.classId && byClass[exam.classId]) byClass[exam.classId].results.push(r);
  }

  const classStats = Object.entries(byClass).map(([classId, data]) => {
    const present = data.results.filter(r => !r.isAbsent);
    const passThreshold = 50;
    const passed = present.filter(r => parseFloat(r.percentage as string || "0") >= passThreshold);
    const avgPct = present.length ? Math.round(present.reduce((s, r) => s + parseFloat(r.percentage as string || "0"), 0) / present.length) : 0;
    const passRate = present.length ? Math.round((passed.length / present.length) * 100) : 0;

    const bySubject: Record<string, number[]> = {};
    for (const r of present) {
      const exam = data.exams.find(e => e.id === r.examId);
      if (exam?.subject) {
        if (!bySubject[exam.subject]) bySubject[exam.subject] = [];
        bySubject[exam.subject].push(parseFloat(r.percentage as string || "0"));
      }
    }
    const weakSubjects = Object.entries(bySubject)
      .filter(([, pcts]) => pcts.reduce((a, b) => a + b, 0) / pcts.length < 50)
      .map(([sub]) => sub);

    return {
      classId: Number(classId),
      className: data.className,
      section: data.section,
      examCount: data.exams.length,
      studentCount: new Set(data.results.map(r => r.studentId)).size,
      avgPercentage: avgPct,
      passRate,
      weakSubjects,
      isWeak: avgPct < 50,
    };
  }).sort((a, b) => a.avgPercentage - b.avgPercentage);

  res.json(classStats);
});

// ── Class Term Combined Results (Class Teacher view) ───────────────────────────
router.get("/class-term-results", requireAuth, async (req, res) => {
  const { classId, examType, session } = req.query;
  const schoolId = req.user!.schoolId!;
  if (!classId || !examType || !session) { res.status(400).json({ error: "classId, examType, session required" }); return; }

  // Get all exams for this class+term
  const exams = await db.select({
    id: examsTable.id, subject: examsTable.subject, totalMarks: examsTable.totalMarks,
    passingMarks: examsTable.passingMarks, status: examsTable.status, marksStatus: examsTable.marksStatus,
    name: examsTable.name, examDate: examsTable.examDate,
  }).from(examsTable).where(and(
    eq(examsTable.schoolId, schoolId),
    eq(examsTable.classId, Number(classId)),
    eq(examsTable.examType, examType as string),
    eq(examsTable.session, session as string),
  ));

  if (exams.length === 0) { res.json({ exams: [], students: [], publishPermission: null }); return; }

  const examIds = exams.map(e => e.id);

  // Get all results for these exams
  const results = await db.select({
    studentId: resultsTable.studentId, studentName: studentsTable.name,
    rollNumber: studentsTable.rollNumber, examId: resultsTable.examId,
    marksObtained: resultsTable.marksObtained, totalMarks: examsTable.totalMarks,
    subject: examsTable.subject, percentage: resultsTable.percentage,
    isAbsent: resultsTable.isAbsent, grade: resultsTable.grade, remarks: resultsTable.remarks,
  }).from(resultsTable)
    .leftJoin(studentsTable, eq(resultsTable.studentId, studentsTable.id))
    .leftJoin(examsTable, eq(resultsTable.examId, examsTable.id))
    .where(inArray(resultsTable.examId, examIds));

  // Get class teacher info
  const classInfo = await db.select({
    id: classesTable.id, name: classesTable.name, section: classesTable.section,
    teacherId: classesTable.teacherId,
  }).from(classesTable).where(eq(classesTable.id, Number(classId))).limit(1);

  let classTeacherName = "";
  if (classInfo[0]?.teacherId) {
    const ct = await db.select({ name: usersTable.name })
      .from(teachersTable).leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
      .where(eq(teachersTable.id, classInfo[0].teacherId)).limit(1);
    classTeacherName = ct[0]?.name ?? "";
  }

  // Get publish permission
  const perm = await db.select().from(classTermPermissionsTable).where(and(
    eq(classTermPermissionsTable.schoolId, schoolId),
    eq(classTermPermissionsTable.classId, Number(classId)),
    eq(classTermPermissionsTable.examType, examType as string),
    eq(classTermPermissionsTable.session, session as string),
  )).limit(1);

  // Build per-student aggregated result
  const byStudent: Record<number, any> = {};
  for (const r of results) {
    if (!byStudent[r.studentId]) {
      byStudent[r.studentId] = { studentId: r.studentId, name: r.studentName ?? "—", rollNumber: r.rollNumber, subjects: {}, totalObtained: 0, totalPossible: 0, absences: 0 };
    }
    const pct = parseFloat(r.percentage as string ?? "0");
    const marks = parseFloat(r.marksObtained as string ?? "0");
    const total = r.totalMarks ?? 0;
    if (r.isAbsent) { byStudent[r.studentId].absences++; }
    else { byStudent[r.studentId].totalObtained += marks; byStudent[r.studentId].totalPossible += total; }
    byStudent[r.studentId].subjects[r.subject!] = { marks: r.isAbsent ? "Absent" : marks, total, pct: r.isAbsent ? 0 : pct, grade: r.grade, isAbsent: r.isAbsent, remarks: r.remarks };
  }

  // Calculate overall percentage and assign positions
  const students = Object.values(byStudent).map(s => ({
    ...s,
    overallPct: s.totalPossible > 0 ? Math.round((s.totalObtained / s.totalPossible) * 100 * 100) / 100 : 0,
    overallGrade: s.totalPossible > 0 ? calcGrade(Math.round(s.totalObtained / s.totalPossible * 100)) : "F",
    passed: s.totalPossible > 0 && (s.totalObtained / s.totalPossible * 100) >= 50,
  })).sort((a, b) => b.overallPct - a.overallPct);

  students.forEach((s, i) => { s.position = i + 1; });

  res.json({ exams, students, classTeacherName, className: classInfo[0]?.name, classSection: classInfo[0]?.section, publishPermission: perm[0] ?? null });
});

// ── Get Publish Permission ─────────────────────────────────────────────────────
router.get("/publish-permission", requireAuth, async (req, res) => {
  const { classId, examType, session } = req.query;
  const schoolId = req.user!.schoolId!;
  if (!classId || !examType || !session) { res.json(null); return; }
  const perm = await db.select().from(classTermPermissionsTable).where(and(
    eq(classTermPermissionsTable.schoolId, schoolId),
    eq(classTermPermissionsTable.classId, Number(classId)),
    eq(classTermPermissionsTable.examType, examType as string),
    eq(classTermPermissionsTable.session, session as string),
  )).limit(1);
  res.json(perm[0] ?? null);
});

// ── Set Publish Permission (Admin only) ────────────────────────────────────────
router.post("/publish-permission", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const { classId, examType, session, enabled } = req.body;
  const schoolId = req.user!.schoolId!;
  const existing = await db.select({ id: classTermPermissionsTable.id })
    .from(classTermPermissionsTable).where(and(
      eq(classTermPermissionsTable.schoolId, schoolId),
      eq(classTermPermissionsTable.classId, Number(classId)),
      eq(classTermPermissionsTable.examType, examType),
      eq(classTermPermissionsTable.session, session),
    )).limit(1);

  if (existing[0]) {
    await db.update(classTermPermissionsTable)
      .set({ publishEnabled: !!enabled, enabledBy: req.user!.id, enabledAt: enabled ? new Date() : null })
      .where(eq(classTermPermissionsTable.id, existing[0].id));
  } else {
    await db.insert(classTermPermissionsTable).values({
      schoolId, classId: Number(classId), examType, session,
      publishEnabled: !!enabled, enabledBy: req.user!.id, enabledAt: enabled ? new Date() : null,
    });
  }
  res.json({ success: true });
});

// ── Class Teacher Publish All Exams in Term ────────────────────────────────────
router.post("/class-term-publish", requireAuth, requireRole("super_admin", "admin", "teacher"), async (req, res) => {
  const { classId, examType, session } = req.body;
  const schoolId = req.user!.schoolId!;

  // Verify permission is enabled (teachers need it, admins bypass)
  if (req.user!.role === "teacher") {
    // Verify teacher is class teacher of this class
    const cls = await db.select({ teacherId: classesTable.teacherId })
      .from(classesTable).where(eq(classesTable.id, Number(classId))).limit(1);
    const teacher = await db.select({ id: teachersTable.id })
      .from(teachersTable).where(eq(teachersTable.userId, req.user!.id)).limit(1);
    if (!teacher[0] || cls[0]?.teacherId !== teacher[0].id) {
      res.status(403).json({ error: "Only class teacher can publish" }); return;
    }
    // Check permission
    const perm = await db.select({ publishEnabled: classTermPermissionsTable.publishEnabled })
      .from(classTermPermissionsTable).where(and(
        eq(classTermPermissionsTable.schoolId, schoolId),
        eq(classTermPermissionsTable.classId, Number(classId)),
        eq(classTermPermissionsTable.examType, examType),
        eq(classTermPermissionsTable.session, session),
      )).limit(1);
    if (!perm[0]?.publishEnabled) { res.status(403).json({ error: "Admin has not enabled publish permission yet" }); return; }
  }

  // Publish all submitted exams for this class+term
  await db.update(examsTable)
    .set({ status: "published", publishedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(examsTable.schoolId, schoolId),
      eq(examsTable.classId, Number(classId)),
      eq(examsTable.examType, examType),
      eq(examsTable.session, session),
      eq(examsTable.marksStatus, "submitted"),
    ));

  // ── Send notifications to students + parents in this class ──────────────────
  try {
    const classInfo = await db.select({ name: classesTable.name, section: classesTable.section })
      .from(classesTable).where(eq(classesTable.id, Number(classId))).limit(1);
    const className = classInfo[0] ? `${classInfo[0].name} ${classInfo[0].section ?? ""}`.trim() : "your class";
    const examLabel = (examType as string).replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    // Get all students in this class with their user IDs
    const students = await db.select({ id: studentsTable.id, userId: studentsTable.userId, name: studentsTable.name })
      .from(studentsTable)
      .where(and(eq(studentsTable.classId, Number(classId)), eq(studentsTable.isActive, true)));

    const studentUserIds = students.map(s => s.userId).filter(Boolean) as number[];
    const studentIds     = students.map(s => s.id);

    // Get parent user IDs
    const parentLinks = studentIds.length > 0
      ? await db.select({ parentUserId: parentStudentsTable.parentUserId })
          .from(parentStudentsTable).where(inArray(parentStudentsTable.studentId, studentIds))
      : [];
    const parentUserIds = [...new Set(parentLinks.map(p => p.parentUserId).filter(Boolean))] as number[];

    const allRecipients = [
      ...studentUserIds.map(uid => ({ userId: uid, isParent: false })),
      ...parentUserIds.map(uid => ({ userId: uid, isParent: true })),
    ];

    if (allRecipients.length > 0) {
      await db.insert(notificationsTable).values(
        allRecipients.map(r => ({
          schoolId,
          userId: r.userId,
          recipientUserId: r.userId,
          title: `📊 ${examLabel} Results Published`,
          message: r.isParent
            ? `Results for ${examLabel} — ${session} — Class ${className} have been published. Log in to view your child's performance.`
            : `Your ${examLabel} results for ${session} — Class ${className} are now available. Log in to view your marks and grades.`,
          type: "result",
        }))
      );
    }

    // ── Auto WhatsApp/SMS to parents ────────────────────────────────────────
    const smsSettings = await db.query.smsSettingsTable.findFirst({
      where: eq(smsSettingsTable.schoolId, schoolId),
    });
    if (smsSettings?.notifyMarks && (smsSettings.smsEnabled || smsSettings.whatsappEnabled) && parentUserIds.length > 0) {
      const parentUsers = await db.select({ phone: usersTable.phone })
        .from(usersTable).where(inArray(usersTable.id, parentUserIds));
      const smsMsg = `📊 ${examLabel} results for ${session} — Class ${className} have been published. Log in to AraSchool to view your child's performance.`;
      for (const pu of parentUsers) {
        if (pu.phone) await sendSmsOrWhatsapp(smsSettings, pu.phone, smsMsg).catch(() => null);
      }
    }
  } catch (_) { /* non-critical — don't fail publish if notification fails */ }

  res.json({ success: true, message: "Results published for all subjects in this term" });
});

// ── Class-Level Bulk Lock All Marks ───────────────────────────────────────────
router.post("/class-term-lock-all", requireAuth, requireRole("super_admin", "admin", "teacher"), async (req, res) => {
  const { classId, examType, session } = req.body;
  const schoolId = req.user!.schoolId!;

  if (!classId || !examType || !session) { res.status(400).json({ error: "classId, examType and session are required" }); return; }

  // Teachers need admin permission to lock
  if (req.user!.role === "teacher") {
    const perm = await db.select({ publishEnabled: classTermPermissionsTable.publishEnabled })
      .from(classTermPermissionsTable).where(and(
        eq(classTermPermissionsTable.schoolId, schoolId),
        eq(classTermPermissionsTable.classId, Number(classId)),
        eq(classTermPermissionsTable.examType, examType),
        eq(classTermPermissionsTable.session, session),
      )).limit(1);
    if (!perm[0]?.publishEnabled) { res.status(403).json({ error: "Admin has not enabled permission yet" }); return; }
  }

  // Lock all submitted/draft exams for this class+term
  await db.update(examsTable)
    .set({ marksStatus: "locked", marksLockedBy: req.user!.id, marksLockedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(examsTable.schoolId, schoolId),
      eq(examsTable.classId, Number(classId)),
      eq(examsTable.examType, examType),
      eq(examsTable.session, session),
      inArray(examsTable.marksStatus, ["submitted", "draft"]),
    ));

  // Notify students & parents
  try {
    const classInfo = await db.select({ name: classesTable.name, section: classesTable.section })
      .from(classesTable).where(eq(classesTable.id, Number(classId))).limit(1);
    const className = classInfo[0] ? `${classInfo[0].name} ${classInfo[0].section ?? ""}`.trim() : "your class";
    const examLabel = (examType as string).replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());

    const students = await db.select({ id: studentsTable.id, userId: studentsTable.userId })
      .from(studentsTable)
      .where(and(eq(studentsTable.classId, Number(classId)), eq(studentsTable.isActive, true)));

    const studentUserIds = students.map(s => s.userId).filter(Boolean) as number[];
    const studentIds     = students.map(s => s.id);

    const parentLinks = studentIds.length > 0
      ? await db.select({ parentUserId: parentStudentsTable.parentUserId })
          .from(parentStudentsTable).where(inArray(parentStudentsTable.studentId, studentIds))
      : [];
    const parentUserIds = [...new Set(parentLinks.map(p => p.parentUserId).filter(Boolean))] as number[];

    const allRecipients = [
      ...studentUserIds.map(uid => ({ userId: uid, isParent: false })),
      ...parentUserIds.map(uid => ({ userId: uid, isParent: true })),
    ];

    if (allRecipients.length > 0) {
      await db.insert(notificationsTable).values(
        allRecipients.map(r => ({
          schoolId,
          userId: r.userId,
          recipientUserId: r.userId,
          title: `🔒 ${examLabel} Marks Locked`,
          message: r.isParent
            ? `Marks for ${examLabel} — ${session} — Class ${className} have been finalized and locked.`
            : `Your ${examLabel} marks for ${session} — Class ${className} have been finalized and locked by your teacher.`,
          type: "result",
        }))
      );
    }
  } catch (_) { /* non-critical */ }

  res.json({ success: true, message: "Marks locked for all subjects in this term" });
});

// ── My Class Papers — class teacher sees ALL exams for their homeroom class ────
// "My Class Papers" is meant for the CLASS TEACHER role:
//   The teacher who is assigned as homeroom teacher of a class can see and
//   manage ALL exam papers for that class, regardless of subject.
// This is SEPARATE from Marks Entry (GET /) which filters by subject assignment.
router.get("/my-papers", requireAuth, async (req, res) => {
  if (req.user!.role !== "teacher") { res.status(403).json({ error: "Forbidden" }); return; }

  const teacher = await db.select({ id: teachersTable.id, schoolId: teachersTable.schoolId })
    .from(teachersTable).where(eq(teachersTable.userId, req.user!.id)).limit(1);
  if (!teacher[0]) { res.status(404).json({ error: "Teacher record not found" }); return; }

  // Find the homeroom class where this teacher is THE class teacher
  const homeroomClasses = await db
    .select({ id: classesTable.id, name: classesTable.name, section: classesTable.section })
    .from(classesTable)
    .where(eq(classesTable.teacherId, teacher[0].id));

  if (homeroomClasses.length === 0) {
    // Teacher is not a homeroom teacher — return empty with a clear message
    res.json({ papers: [], noHomeroomClass: true });
    return;
  }

  const homeroomClassIds = homeroomClasses.map(c => c.id);

  const exams = await db
    .select({
      id:           examsTable.id,
      name:         examsTable.name,
      subject:      examsTable.subject,
      classId:      examsTable.classId,
      totalMarks:   examsTable.totalMarks,
      passingMarks: examsTable.passingMarks,
      examDate:     examsTable.examDate,
      examType:     examsTable.examType,
      session:      examsTable.session,
      status:       examsTable.status,
      marksStatus:  examsTable.marksStatus,
      description:  examsTable.description,
      schoolId:     examsTable.schoolId,
      className:    classesTable.name,
      classSection: classesTable.section,
    })
    .from(examsTable)
    .leftJoin(classesTable, eq(examsTable.classId, classesTable.id))
    .where(and(
      eq(examsTable.schoolId, teacher[0].schoolId!),
      inArray(examsTable.classId, homeroomClassIds),
    ))
    .orderBy(desc(examsTable.examDate));

  // Attach students for each exam
  const result = await Promise.all(exams.map(async exam => {
    const students = await db
      .select({
        id:          studentsTable.id,
        name:        studentsTable.name,
        rollNumber:  studentsTable.rollNumber,
      })
      .from(studentsTable)
      .where(and(eq(studentsTable.classId, exam.classId!), eq(studentsTable.isActive, true)))
      .orderBy(asc(studentsTable.rollNumber));

    const results = students.length > 0
      ? await db.select({
          studentId:     resultsTable.studentId,
          marksObtained: resultsTable.marksObtained,
          isAbsent:      resultsTable.isAbsent,
          grade:         resultsTable.grade,
          remarks:       resultsTable.remarks,
        })
        .from(resultsTable)
        .where(and(eq(resultsTable.examId, exam.id), inArray(resultsTable.studentId, students.map(s => s.id))))
      : [];

    const resultMap = new Map(results.map(r => [r.studentId, r]));

    return {
      ...exam,
      students: students.map(s => ({ ...s, result: resultMap.get(s.id) ?? null })),
    };
  }));

  res.json(result);
});

// ── Get Single Exam ────────────────────────────────────────────────────────────
router.get("/:examId", requireAuth, async (req, res) => {
  const rows = await db
    .select({
      id: examsTable.id, schoolId: examsTable.schoolId, classId: examsTable.classId,
      name: examsTable.name, subject: examsTable.subject,
      totalMarks: examsTable.totalMarks, passingMarks: examsTable.passingMarks,
      examDate: examsTable.examDate, examType: examsTable.examType,
      session: examsTable.session, status: examsTable.status,
      startTime: examsTable.startTime, endTime: examsTable.endTime,
      venue: examsTable.venue, marksStatus: examsTable.marksStatus,
      description: examsTable.description, publishedAt: examsTable.publishedAt,
      resultPublishDate: examsTable.resultPublishDate,
      createdAt: examsTable.createdAt,
      className: classesTable.name, classSection: classesTable.section,
    })
    .from(examsTable)
    .leftJoin(classesTable, eq(examsTable.classId, classesTable.id))
    .where(eq(examsTable.id, Number(req.params.examId)));

  if (!rows[0]) { res.status(404).json({ error: "Exam not found" }); return; }
  res.json(rows[0]);
});

// ── Create Exam ────────────────────────────────────────────────────────────────
router.post("/", requireAuth, requireRole("super_admin", "admin", "teacher"), async (req, res) => {
  const {
    schoolId, classId, name, subject, totalMarks, passingMarks,
    examDate, examType, session, status, startTime, endTime, venue,
    invigilatorId, checkerId, description, resultPublishDate
  } = req.body;

  const nullIfEmpty = (v: any) => (v === "" || v === null || v === undefined) ? undefined : v;

  const [exam] = await db.insert(examsTable).values({
    schoolId: schoolId || req.user!.schoolId!,
    classId: Number(classId),
    name, subject: normalizeSubject(subject),
    totalMarks: Number(totalMarks),
    passingMarks: Number(passingMarks),
    examDate: nullIfEmpty(examDate),
    examType: examType || "class_test",
    session: nullIfEmpty(session),
    status: status || "draft",
    startTime: nullIfEmpty(startTime),
    endTime: nullIfEmpty(endTime),
    venue: nullIfEmpty(venue),
    invigilatorId: invigilatorId ? Number(invigilatorId) : undefined,
    checkerId: checkerId ? Number(checkerId) : undefined,
    description: nullIfEmpty(description),
    resultPublishDate: nullIfEmpty(resultPublishDate),
    createdBy: req.user!.id,
  }).returning();

  res.status(201).json(exam);
});

// ── Update Exam ────────────────────────────────────────────────────────────────
router.put("/:examId", requireAuth, requireRole("super_admin", "admin", "teacher"), async (req, res) => {
  const {
    name, subject, totalMarks, passingMarks, examDate, examType,
    session, status, startTime, endTime, venue, invigilatorId, checkerId, description
  } = req.body;

  const nullIfEmpty2 = (v: any) => (v === "" || v === null || v === undefined) ? undefined : v;

  const [exam] = await db.update(examsTable)
    .set({
      name, subject: normalizeSubject(subject), totalMarks, passingMarks,
      examDate: nullIfEmpty2(examDate),
      examType,
      session: nullIfEmpty2(session),
      status,
      startTime: nullIfEmpty2(startTime),
      endTime: nullIfEmpty2(endTime),
      venue: nullIfEmpty2(venue),
      invigilatorId: invigilatorId ? Number(invigilatorId) : undefined,
      checkerId: checkerId ? Number(checkerId) : undefined,
      description: nullIfEmpty2(description),
      updatedAt: new Date(),
    })
    .where(eq(examsTable.id, Number(req.params.examId)))
    .returning();

  if (!exam) { res.status(404).json({ error: "Not found" }); return; }
  res.json(exam);
});

// ── Publish Exam ───────────────────────────────────────────────────────────────
router.post("/:examId/publish", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const examId  = Number(req.params.examId);
  const schoolId = req.user!.schoolId!;

  const [exam] = await db.update(examsTable)
    .set({ status: "published", publishedAt: new Date(), updatedAt: new Date() })
    .where(eq(examsTable.id, examId))
    .returning();

  await logAudit({
    schoolId, examId, changedByUserId: req.user!.id,
    action: "result_publish", note: "Exam published by admin",
  });

  // ── Notify students + parents ──────────────────────────────────────────────
  try {
    if (exam) {
      const examLabel = (exam.examType ?? "Exam").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const students = await db.select({ id: studentsTable.id, userId: studentsTable.userId })
        .from(studentsTable)
        .where(and(eq(studentsTable.classId, exam.classId!), eq(studentsTable.isActive, true)));
      const studentUserIds = students.map(s => s.userId).filter(Boolean) as number[];
      const studentIds     = students.map(s => s.id);
      const parentLinks    = studentIds.length > 0
        ? await db.select({ parentUserId: parentStudentsTable.parentUserId })
            .from(parentStudentsTable).where(inArray(parentStudentsTable.studentId, studentIds))
        : [];
      const parentUserIds = [...new Set(parentLinks.map(p => p.parentUserId).filter(Boolean))] as number[];

      const allRecipients = [
        ...studentUserIds.map(uid => ({ uid, isParent: false })),
        ...parentUserIds.map(uid => ({ uid, isParent: true })),
      ];
      if (allRecipients.length > 0) {
        await db.insert(notificationsTable).values(allRecipients.map(r => ({
          schoolId,
          userId: r.uid,
          recipientUserId: r.uid,
          title: `📊 ${examLabel} Result Published — ${exam.subject}`,
          message: r.isParent
            ? `${exam.subject} ${examLabel} result has been published. Log in to check your child's marks and grades.`
            : `Your ${exam.subject} ${examLabel} result is now available. Log in to view your marks, grade and position.`,
          type: "result",
        })));
      }
    }
  } catch (_) { /* non-critical */ }

  res.json({ success: true, message: "Exam published" });
});

// ── Lock / Unlock Marks ────────────────────────────────────────────────────────
router.post("/:examId/lock-marks", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const examId = Number(req.params.examId);
  const { lock } = req.body;

  await db.update(examsTable)
    .set({
      marksStatus: lock ? "locked" : "submitted",
      marksLockedBy: lock ? req.user!.id : undefined,
      marksLockedAt: lock ? new Date() : undefined,
      updatedAt: new Date(),
    })
    .where(eq(examsTable.id, examId));

  await logAudit({
    schoolId: req.user!.schoolId!,
    examId, changedByUserId: req.user!.id,
    action: lock ? "marks_lock" : "marks_unlock",
    note: lock ? "Marks locked by admin" : "Marks unlocked by admin",
  });

  res.json({ success: true, marksStatus: lock ? "locked" : "submitted" });
});

// ── Delete Exam ────────────────────────────────────────────────────────────────
router.delete("/:examId", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const examId = Number(req.params.examId);
  await db.delete(resultsTable).where(eq(resultsTable.examId, examId));
  await db.delete(examAuditLogsTable).where(eq(examAuditLogsTable.examId, examId));
  await db.delete(recheckRequestsTable).where(eq(recheckRequestsTable.examId, examId));
  await db.delete(examsTable).where(eq(examsTable.id, examId));
  res.json({ success: true, message: "Exam deleted" });
});

// ── Results — Get by Exam ──────────────────────────────────────────────────────
router.get("/results/all", requireAuth, async (req, res) => {
  const examId    = req.query.examId    ? Number(req.query.examId)    : undefined;
  const studentId = req.query.studentId ? Number(req.query.studentId) : undefined;
  const classId   = req.query.classId   ? Number(req.query.classId)   : undefined;
  const schoolId  = req.query.schoolId  ? Number(req.query.schoolId)  : req.user!.schoolId;
  const session   = req.query.session   as string | undefined;

  const conds: any[] = [];
  if (examId)    conds.push(eq(resultsTable.examId, examId));
  if (studentId) conds.push(eq(resultsTable.studentId, studentId));

  let results = await db
    .select({
      id: resultsTable.id,
      examId: resultsTable.examId,
      studentId: resultsTable.studentId,
      marksObtained: resultsTable.marksObtained,
      grade: resultsTable.grade,
      percentage: resultsTable.percentage,
      position: resultsTable.position,
      isAbsent: resultsTable.isAbsent,
      isDraft: resultsTable.isDraft,
      remarks: resultsTable.remarks,
      createdAt: resultsTable.createdAt,
      updatedAt: resultsTable.updatedAt,
      studentName: studentsTable.name,
      rollNumber: studentsTable.rollNumber,
      examName: examsTable.name,
      subject: examsTable.subject,
      totalMarks: examsTable.totalMarks,
      passingMarks: examsTable.passingMarks,
      examDate: examsTable.examDate,
      examType: examsTable.examType,
      examStatus: examsTable.status,
      marksStatus: examsTable.marksStatus,
      classId: examsTable.classId,
      className: classesTable.name,
      classSection: classesTable.section,
    })
    .from(resultsTable)
    .leftJoin(studentsTable, eq(resultsTable.studentId, studentsTable.id))
    .leftJoin(examsTable, eq(resultsTable.examId, examsTable.id))
    .leftJoin(classesTable, eq(examsTable.classId, classesTable.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(resultsTable.position));

  if (classId) {
    results = results.filter(r => r.classId === classId);
  }
  if (session) {
    results = results.filter(r => (r as any).session === session);
  }
  if (schoolId) {
    const schoolExams = await db.select({ id: examsTable.id })
      .from(examsTable).where(eq(examsTable.schoolId, schoolId));
    const examIds = new Set(schoolExams.map(e => e.id));
    results = results.filter(r => examIds.has(r.examId));
  }

  res.json(results);
});


// ── Marks Entry — Bulk Submit ──────────────────────────────────────────────────
router.post("/results/bulk", requireAuth, requireRole("super_admin", "admin", "teacher"), async (req, res) => {
  const { examId, entries, isDraft } = req.body;
  // entries: [{ studentId, marksObtained, isAbsent, remarks }]

  const exam = await db.query.examsTable.findFirst({ where: eq(examsTable.id, Number(examId)) });
  if (!exam) { res.status(404).json({ error: "Exam not found" }); return; }
  if (exam.marksStatus === "locked") { res.status(403).json({ error: "Marks are locked" }); return; }

  const schoolId = req.user!.schoolId!;
  const userId   = req.user!.id;

  for (const entry of entries) {
    const { studentId, marksObtained, isAbsent, remarks } = entry;
    const obtained = isAbsent ? 0 : Number(marksObtained);
    const pct  = exam.totalMarks > 0 ? (obtained / exam.totalMarks) * 100 : 0;
    const grade = isAbsent ? "AB" : calcGrade(pct);

    const existing = await db.query.resultsTable.findFirst({
      where: and(eq(resultsTable.examId, Number(examId)), eq(resultsTable.studentId, Number(studentId))),
    });

    if (existing) {
      const oldVal = existing.marksObtained;
      await db.update(resultsTable)
        .set({
          marksObtained: obtained.toString(),
          grade, percentage: pct.toFixed(2),
          isAbsent: !!isAbsent, isDraft: !!isDraft, remarks,
          updatedAt: new Date(),
        })
        .where(eq(resultsTable.id, existing.id));

      await logAudit({
        schoolId, examId: Number(examId), studentId: Number(studentId),
        changedByUserId: userId, action: "marks_update",
        oldValue: oldVal?.toString(), newValue: obtained.toString(),
      });
    } else {
      await db.insert(resultsTable).values({
        examId: Number(examId), studentId: Number(studentId),
        marksObtained: obtained.toString(),
        grade, percentage: pct.toFixed(2),
        isAbsent: !!isAbsent, isDraft: !!isDraft, remarks,
      });

      await logAudit({
        schoolId, examId: Number(examId), studentId: Number(studentId),
        changedByUserId: userId, action: "marks_entry",
        newValue: obtained.toString(),
      });
    }
  }

  // Auto-update marksStatus
  const newStatus = isDraft ? "draft" : "submitted";
  await db.update(examsTable)
    .set({ marksStatus: newStatus, updatedAt: new Date() })
    .where(eq(examsTable.id, Number(examId)));

  res.json({ success: true, message: isDraft ? "Draft saved" : "Marks submitted" });
});

// ── Single Result (legacy) ─────────────────────────────────────────────────────
router.post("/results", requireAuth, async (req, res) => {
  const { examId, studentId, marksObtained, remarks } = req.body;
  const exam = await db.query.examsTable.findFirst({ where: eq(examsTable.id, examId) });
  if (!exam) { res.status(404).json({ error: "Exam not found" }); return; }

  const pct   = (marksObtained / exam.totalMarks) * 100;
  const grade = calcGrade(pct);

  const existing = await db.query.resultsTable.findFirst({
    where: and(eq(resultsTable.examId, examId), eq(resultsTable.studentId, studentId)),
  });

  if (existing) {
    const [updated] = await db.update(resultsTable)
      .set({ marksObtained: marksObtained.toString(), grade, percentage: pct.toFixed(2), remarks, updatedAt: new Date() })
      .where(eq(resultsTable.id, existing.id)).returning();
    return res.status(201).json({ ...updated, percentage: pct });
  }

  const [result] = await db.insert(resultsTable).values({
    examId, studentId, marksObtained: marksObtained.toString(),
    grade, percentage: pct.toFixed(2), remarks,
  }).returning();

  res.status(201).json({ ...result, percentage: pct });
});

// ── Generate Positions for an Exam ────────────────────────────────────────────
router.post("/:examId/generate-positions", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const examId = Number(req.params.examId);

  const results = await db.select()
    .from(resultsTable)
    .where(and(eq(resultsTable.examId, examId), eq(resultsTable.isAbsent, false)))
    .orderBy(desc(sql`CAST(${resultsTable.marksObtained} AS FLOAT)`));

  let position = 1;
  for (const r of results) {
    await db.update(resultsTable).set({ position, updatedAt: new Date() }).where(eq(resultsTable.id, r.id));
    position++;
  }

  await logAudit({
    schoolId: req.user!.schoolId!,
    examId, changedByUserId: req.user!.id,
    action: "positions_generated",
    note: `Positions generated for ${results.length} students`,
  });

  res.json({ success: true, message: `Positions generated for ${results.length} students` });
});

// ── Analytics ─────────────────────────────────────────────────────────────────
router.get("/:examId/analytics", requireAuth, async (req, res) => {
  const examId = Number(req.params.examId);

  const exam = await db.query.examsTable.findFirst({ where: eq(examsTable.id, examId) });
  if (!exam) { res.status(404).json({ error: "Not found" }); return; }

  const results = await db
    .select({
      studentId: resultsTable.studentId,
      marksObtained: resultsTable.marksObtained,
      percentage: resultsTable.percentage,
      grade: resultsTable.grade,
      position: resultsTable.position,
      isAbsent: resultsTable.isAbsent,
      studentName: studentsTable.name,
      rollNumber: studentsTable.rollNumber,
    })
    .from(resultsTable)
    .leftJoin(studentsTable, eq(resultsTable.studentId, studentsTable.id))
    .where(eq(resultsTable.examId, examId))
    .orderBy(asc(resultsTable.position));

  const nonAbsent = results.filter(r => !r.isAbsent);
  const passing   = nonAbsent.filter(r => parseFloat(r.percentage as string || "0") >= (exam.passingMarks / exam.totalMarks) * 100);
  const failing   = nonAbsent.filter(r => parseFloat(r.percentage as string || "0") < (exam.passingMarks / exam.totalMarks) * 100);

  const grades: Record<string, number> = {};
  nonAbsent.forEach(r => { grades[r.grade || "F"] = (grades[r.grade || "F"] || 0) + 1; });

  const avgPct = nonAbsent.length
    ? nonAbsent.reduce((s, r) => s + parseFloat(r.percentage as string || "0"), 0) / nonAbsent.length
    : 0;

  res.json({
    exam,
    totalStudents: results.length,
    appeared: nonAbsent.length,
    absent: results.filter(r => r.isAbsent).length,
    passed: passing.length,
    failed: failing.length,
    passRate: nonAbsent.length ? ((passing.length / nonAbsent.length) * 100).toFixed(1) : "0",
    avgPercentage: avgPct.toFixed(1),
    gradeDistribution: grades,
    topStudents: nonAbsent.slice(0, 5),
    weakStudents: nonAbsent.sort((a, b) =>
      parseFloat(a.percentage as string || "0") - parseFloat(b.percentage as string || "0")
    ).slice(0, 5),
    allResults: results,
  });
});

// ── Class-wide Analytics (multi-exam) ────────────────────────────────────────
router.get("/analytics/class", requireAuth, async (req, res) => {
  const classId  = req.query.classId  ? Number(req.query.classId)  : undefined;
  const schoolId = req.query.schoolId ? Number(req.query.schoolId) : req.user!.schoolId;
  const session  = req.query.session  as string | undefined;

  const examConds: any[] = [];
  if (schoolId) examConds.push(eq(examsTable.schoolId, schoolId));
  if (classId)  examConds.push(eq(examsTable.classId,  classId));
  if (session)  examConds.push(eq(examsTable.session,  session));

  const exams = await db.select({ id: examsTable.id, name: examsTable.name, subject: examsTable.subject })
    .from(examsTable).where(examConds.length ? and(...examConds) : undefined);

  const examIds = exams.map(e => e.id);
  if (!examIds.length) { res.json({ exams: [], subjectPerformance: [], studentSummary: [] }); return; }

  const allResults = await db
    .select({
      examId: resultsTable.examId,
      studentId: resultsTable.studentId,
      marksObtained: resultsTable.marksObtained,
      percentage: resultsTable.percentage,
      grade: resultsTable.grade,
      isAbsent: resultsTable.isAbsent,
      studentName: studentsTable.name,
      rollNumber: studentsTable.rollNumber,
      subject: examsTable.subject,
      examName: examsTable.name,
      totalMarks: examsTable.totalMarks,
    })
    .from(resultsTable)
    .leftJoin(studentsTable, eq(resultsTable.studentId, studentsTable.id))
    .leftJoin(examsTable, eq(resultsTable.examId, examsTable.id))
    .where(inArray(resultsTable.examId, examIds));

  // Subject performance
  const bySubject: Record<string, number[]> = {};
  allResults.forEach(r => {
    if (!r.isAbsent && r.subject) {
      if (!bySubject[r.subject]) bySubject[r.subject] = [];
      bySubject[r.subject].push(parseFloat(r.percentage as string || "0"));
    }
  });

  const subjectPerformance = Object.entries(bySubject).map(([subject, pcts]) => ({
    subject,
    avgPercentage: (pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(1),
    count: pcts.length,
  })).sort((a, b) => parseFloat(b.avgPercentage) - parseFloat(a.avgPercentage));

  // Student summary
  const byStudent: Record<number, { name: string; roll: string; total: number; count: number }> = {};
  allResults.forEach(r => {
    if (!r.isAbsent) {
      if (!byStudent[r.studentId]) byStudent[r.studentId] = { name: r.studentName || "", roll: r.rollNumber || "", total: 0, count: 0 };
      byStudent[r.studentId].total += parseFloat(r.percentage as string || "0");
      byStudent[r.studentId].count++;
    }
  });

  const studentSummary = Object.entries(byStudent).map(([id, d]) => ({
    studentId: Number(id),
    studentName: d.name,
    rollNumber: d.roll,
    avgPercentage: (d.total / d.count).toFixed(1),
    examsCount: d.count,
  })).sort((a, b) => parseFloat(b.avgPercentage) - parseFloat(a.avgPercentage));

  res.json({ exams, subjectPerformance, studentSummary });
});

// ── Student Results (for student portal) ─────────────────────────────────────
// Shows results when exam is "published" OR marks have been submitted/locked
// (so students don't have to wait for explicit publish action)
router.get("/student/:studentId/results", requireAuth, async (req, res) => {
  const studentId = Number(req.params.studentId);
  const session   = req.query.session as string | undefined;

  const conds: any[] = [
    eq(resultsTable.studentId, studentId),
    eq(resultsTable.isDraft, false),
    or(
      eq(examsTable.status, "published"),
      inArray(examsTable.marksStatus, ["submitted", "locked"]),
    )!,
  ];

  const results = await db
    .select({
      id: resultsTable.id,
      examId: resultsTable.examId,
      marksObtained: resultsTable.marksObtained,
      grade: resultsTable.grade,
      percentage: resultsTable.percentage,
      position: resultsTable.position,
      isAbsent: resultsTable.isAbsent,
      remarks: resultsTable.remarks,
      examName: examsTable.name,
      subject: examsTable.subject,
      totalMarks: examsTable.totalMarks,
      passingMarks: examsTable.passingMarks,
      examDate: examsTable.examDate,
      examType: examsTable.examType,
      session: examsTable.session,
      className: classesTable.name,
    })
    .from(resultsTable)
    .leftJoin(examsTable, eq(resultsTable.examId, examsTable.id))
    .leftJoin(classesTable, eq(examsTable.classId, classesTable.id))
    .where(and(...conds))
    .orderBy(desc(examsTable.examDate));

  const filtered = session ? results.filter(r => r.session === session) : results;
  res.json(filtered);
});

// ── Recheck Requests ──────────────────────────────────────────────────────────
router.get("/recheck/all", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId!;

  const requests = await db
    .select({
      id: recheckRequestsTable.id,
      examId: recheckRequestsTable.examId,
      studentId: recheckRequestsTable.studentId,
      reason: recheckRequestsTable.reason,
      status: recheckRequestsTable.status,
      newMarks: recheckRequestsTable.newMarks,
      adminNote: recheckRequestsTable.adminNote,
      resolvedAt: recheckRequestsTable.resolvedAt,
      createdAt: recheckRequestsTable.createdAt,
      studentName: studentsTable.name,
      examName: examsTable.name,
      subject: examsTable.subject,
    })
    .from(recheckRequestsTable)
    .leftJoin(studentsTable, eq(recheckRequestsTable.studentId, studentsTable.id))
    .leftJoin(examsTable, eq(recheckRequestsTable.examId, examsTable.id))
    .where(eq(recheckRequestsTable.schoolId, schoolId))
    .orderBy(desc(recheckRequestsTable.createdAt));

  res.json(requests);
});

router.post("/recheck/request", requireAuth, async (req, res) => {
  const { examId, studentId, reason } = req.body;
  const schoolId = req.user!.schoolId!;

  // Check if request already exists
  const existing = await db.query.recheckRequestsTable.findFirst({
    where: and(
      eq(recheckRequestsTable.examId, Number(examId)),
      eq(recheckRequestsTable.studentId, Number(studentId)),
      eq(recheckRequestsTable.schoolId, schoolId),
    ),
  });
  if (existing && existing.status === "pending") {
    res.status(400).json({ error: "Recheck request already pending for this exam" }); return;
  }

  const [request] = await db.insert(recheckRequestsTable).values({
    schoolId,
    examId: Number(examId),
    studentId: Number(studentId),
    requestedByUserId: req.user!.id,
    reason,
  }).returning();

  res.status(201).json(request);
});

router.put("/recheck/:requestId", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const { status, newMarks, adminNote } = req.body;

  const [updated] = await db.update(recheckRequestsTable)
    .set({
      status,
      newMarks: newMarks ? newMarks.toString() : undefined,
      adminNote,
      resolvedByUserId: req.user!.id,
      resolvedAt: new Date(),
    })
    .where(eq(recheckRequestsTable.id, Number(req.params.requestId)))
    .returning();

  // If approved, update marks
  if (status === "approved" && newMarks && updated) {
    const exam = await db.query.examsTable.findFirst({ where: eq(examsTable.id, updated.examId) });
    if (exam) {
      const pct   = (Number(newMarks) / exam.totalMarks) * 100;
      const grade = calcGrade(pct);
      await db.update(resultsTable)
        .set({
          marksObtained: newMarks.toString(),
          grade, percentage: pct.toFixed(2), updatedAt: new Date(),
        })
        .where(and(eq(resultsTable.examId, updated.examId), eq(resultsTable.studentId, updated.studentId)));

      await logAudit({
        schoolId: req.user!.schoolId!,
        examId: updated.examId,
        studentId: updated.studentId,
        changedByUserId: req.user!.id,
        action: "recheck_approved",
        oldValue: undefined,
        newValue: newMarks.toString(),
        note: `Recheck approved. New marks: ${newMarks}`,
      });
    }
  }

  res.json(updated);
});

// ── Audit Logs ────────────────────────────────────────────────────────────────
router.get("/audit/logs", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const examId   = req.query.examId ? Number(req.query.examId) : undefined;

  const conds: any[] = [eq(examAuditLogsTable.schoolId, schoolId)];
  if (examId) conds.push(eq(examAuditLogsTable.examId, examId));

  const logs = await db
    .select({
      id: examAuditLogsTable.id,
      examId: examAuditLogsTable.examId,
      studentId: examAuditLogsTable.studentId,
      action: examAuditLogsTable.action,
      oldValue: examAuditLogsTable.oldValue,
      newValue: examAuditLogsTable.newValue,
      note: examAuditLogsTable.note,
      createdAt: examAuditLogsTable.createdAt,
      changedByName: usersTable.name,
      studentName: studentsTable.name,
      examName: examsTable.name,
    })
    .from(examAuditLogsTable)
    .leftJoin(usersTable, eq(examAuditLogsTable.changedByUserId, usersTable.id))
    .leftJoin(studentsTable, eq(examAuditLogsTable.studentId, studentsTable.id))
    .leftJoin(examsTable, eq(examAuditLogsTable.examId, examsTable.id))
    .where(and(...conds))
    .orderBy(desc(examAuditLogsTable.createdAt))
    .limit(200);

  res.json(logs);
});

export default router;
