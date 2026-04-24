import { Router } from "express";
import { db, teachersTable, usersTable, classesTable,
  teacherResponsibilitiesTable, teacherDutiesTable, teacherRecordsTable,
  teacherReplacementsTable, teacherPermissionsTable, teacherContractsTable,
  teacherMeetingsTable, teacherPerformanceTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth.js";

const router = Router();
const adminOnly = requireRole("super_admin", "admin");

// ─── Helpers ────────────────────────────────────────────────────────────────

function schoolId(req: any): number {
  return Number(req.query.schoolId || req.user!.schoolId);
}

// ─── Feature 1: Responsibilities ────────────────────────────────────────────

router.get("/:teacherId/responsibilities", requireAuth, async (req, res) => {
  const rows = await db.select().from(teacherResponsibilitiesTable)
    .where(eq(teacherResponsibilitiesTable.teacherId, Number(req.params.teacherId)))
    .orderBy(desc(teacherResponsibilitiesTable.createdAt));
  res.json(rows);
});

router.post("/:teacherId/responsibilities", requireAuth, adminOnly, async (req, res) => {
  const { classId, subjects, periodsPerDay, examDuty, eventDuty, notes } = req.body;
  const sid = schoolId(req);
  const [row] = await db.insert(teacherResponsibilitiesTable).values({
    teacherId: Number(req.params.teacherId),
    schoolId: sid,
    classId: classId ? Number(classId) : null,
    subjects: subjects ? JSON.stringify(subjects) : null,
    periodsPerDay: periodsPerDay ? Number(periodsPerDay) : 0,
    examDuty: !!examDuty,
    eventDuty: !!eventDuty,
    notes,
  }).returning();
  res.status(201).json(row);
});

router.put("/:teacherId/responsibilities/:id", requireAuth, adminOnly, async (req, res) => {
  const { classId, subjects, periodsPerDay, examDuty, eventDuty, notes } = req.body;
  const [row] = await db.update(teacherResponsibilitiesTable).set({
    classId: classId ? Number(classId) : null,
    subjects: subjects ? JSON.stringify(subjects) : null,
    periodsPerDay: periodsPerDay ? Number(periodsPerDay) : 0,
    examDuty: !!examDuty,
    eventDuty: !!eventDuty,
    notes,
    updatedAt: new Date(),
  }).where(eq(teacherResponsibilitiesTable.id, Number(req.params.id))).returning();
  res.json(row);
});

router.delete("/:teacherId/responsibilities/:id", requireAuth, adminOnly, async (req, res) => {
  await db.delete(teacherResponsibilitiesTable).where(eq(teacherResponsibilitiesTable.id, Number(req.params.id)));
  res.json({ success: true });
});

// ─── Feature 2: Workload Summary ────────────────────────────────────────────

router.get("/workload", requireAuth, async (req, res) => {
  const sid = schoolId(req);
  const teachers = await db
    .select({ id: teachersTable.id, name: usersTable.name, teacherCode: teachersTable.teacherCode })
    .from(teachersTable)
    .leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(and(eq(teachersTable.schoolId, sid), eq(teachersTable.isActive, true)));

  const responsibilities = await db.select().from(teacherResponsibilitiesTable)
    .where(eq(teacherResponsibilitiesTable.schoolId, sid));

  const duties = await db.select().from(teacherDutiesTable)
    .where(eq(teacherDutiesTable.schoolId, sid));

  const workload = teachers.map(t => {
    const tResp = responsibilities.filter(r => r.teacherId === t.id);
    const tDuties = duties.filter(d => d.teacherId === t.id);
    const totalPeriods = tResp.reduce((s, r) => s + (r.periodsPerDay || 0), 0);
    const totalSubjects = tResp.reduce((s, r) => s + (JSON.parse(r.subjects || "[]") as string[]).length, 0);
    const totalDuties = tDuties.length;
    const score = totalPeriods * 3 + totalSubjects * 5 + totalDuties * 2;
    return { ...t, totalPeriods, totalSubjects, totalDuties, workloadScore: score };
  });

  const avg = workload.length ? workload.reduce((s, w) => s + w.workloadScore, 0) / workload.length : 0;
  const labeled = workload.map(w => ({
    ...w,
    status: w.workloadScore > avg * 1.3 ? "overloaded" : w.workloadScore < avg * 0.7 ? "underloaded" : "balanced",
  }));

  res.json({ teachers: labeled.sort((a, b) => b.workloadScore - a.workloadScore), avgScore: Math.round(avg) });
});

// ─── Feature 3: Duty Calendar ────────────────────────────────────────────────

router.get("/:teacherId/duties", requireAuth, async (req, res) => {
  const rows = await db.select().from(teacherDutiesTable)
    .where(eq(teacherDutiesTable.teacherId, Number(req.params.teacherId)))
    .orderBy(desc(teacherDutiesTable.dutyDate));
  res.json(rows);
});

router.post("/:teacherId/duties", requireAuth, adminOnly, async (req, res) => {
  const { type, title, dutyDate, description } = req.body;
  const [row] = await db.insert(teacherDutiesTable).values({
    teacherId: Number(req.params.teacherId),
    schoolId: schoolId(req),
    type, title, dutyDate, description,
  }).returning();
  res.status(201).json(row);
});

router.delete("/:teacherId/duties/:id", requireAuth, adminOnly, async (req, res) => {
  await db.delete(teacherDutiesTable).where(eq(teacherDutiesTable.id, Number(req.params.id)));
  res.json({ success: true });
});

// ─── Feature 4: Warning / Appreciation Records ──────────────────────────────

router.get("/:teacherId/records", requireAuth, async (req, res) => {
  const rows = await db.select().from(teacherRecordsTable)
    .where(eq(teacherRecordsTable.teacherId, Number(req.params.teacherId)))
    .orderBy(desc(teacherRecordsTable.recordDate));
  res.json(rows);
});

router.post("/:teacherId/records", requireAuth, adminOnly, async (req, res) => {
  const { type, title, description, recordDate } = req.body;
  const [row] = await db.insert(teacherRecordsTable).values({
    teacherId: Number(req.params.teacherId),
    schoolId: schoolId(req),
    type, title, description, recordDate,
  }).returning();
  res.status(201).json(row);
});

router.delete("/:teacherId/records/:id", requireAuth, adminOnly, async (req, res) => {
  await db.delete(teacherRecordsTable).where(eq(teacherRecordsTable.id, Number(req.params.id)));
  res.json({ success: true });
});

// ─── Feature 5: Replacement Management ──────────────────────────────────────

router.get("/replacements", requireAuth, async (req, res) => {
  const sid = schoolId(req);
  const rows = await db
    .select({
      id: teacherReplacementsTable.id,
      replacementDate: teacherReplacementsTable.replacementDate,
      reason: teacherReplacementsTable.reason,
      status: teacherReplacementsTable.status,
      classId: teacherReplacementsTable.classId,
      absentTeacherId: teacherReplacementsTable.absentTeacherId,
      replacementTeacherId: teacherReplacementsTable.replacementTeacherId,
      className: classesTable.name,
      classSection: classesTable.section,
    })
    .from(teacherReplacementsTable)
    .leftJoin(classesTable, eq(teacherReplacementsTable.classId, classesTable.id))
    .where(eq(teacherReplacementsTable.schoolId, sid))
    .orderBy(desc(teacherReplacementsTable.replacementDate));

  // Fetch teacher names
  const teachers = await db
    .select({ id: teachersTable.id, name: usersTable.name })
    .from(teachersTable).leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(eq(teachersTable.schoolId, sid));
  const tMap = new Map(teachers.map(t => [t.id, t.name]));

  res.json(rows.map(r => ({
    ...r,
    absentTeacherName: tMap.get(r.absentTeacherId) ?? "—",
    replacementTeacherName: tMap.get(r.replacementTeacherId) ?? "—",
  })));
});

router.post("/replacements", requireAuth, adminOnly, async (req, res) => {
  const { absentTeacherId, replacementTeacherId, classId, replacementDate, reason } = req.body;
  const [row] = await db.insert(teacherReplacementsTable).values({
    schoolId: schoolId(req),
    absentTeacherId: Number(absentTeacherId),
    replacementTeacherId: Number(replacementTeacherId),
    classId: classId ? Number(classId) : null,
    replacementDate, reason,
    status: "active",
  }).returning();
  res.status(201).json(row);
});

router.patch("/replacements/:id", requireAuth, adminOnly, async (req, res) => {
  const [row] = await db.update(teacherReplacementsTable)
    .set({ status: req.body.status })
    .where(eq(teacherReplacementsTable.id, Number(req.params.id)))
    .returning();
  res.json(row);
});

router.delete("/replacements/:id", requireAuth, adminOnly, async (req, res) => {
  await db.delete(teacherReplacementsTable).where(eq(teacherReplacementsTable.id, Number(req.params.id)));
  res.json({ success: true });
});

// ─── All Responsibilities (school-wide, for schedule chart) ──────────────────
router.get("/all-responsibilities", requireAuth, async (req, res) => {
  const sid = schoolId(req);
  const allTeachers = await db
    .select({ id: teachersTable.id, name: usersTable.name })
    .from(teachersTable).leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(eq(teachersTable.schoolId, sid));

  const tIds = allTeachers.map(t => t.id!);
  if (tIds.length === 0) return res.json([]);

  const allResp: any[] = [];
  for (const tid of tIds) {
    const rows = await db.select().from(teacherResponsibilitiesTable)
      .where(eq(teacherResponsibilitiesTable.teacherId, tid));
    const teacher = allTeachers.find(t => t.id === tid);
    for (const r of rows) {
      const cls = await db.select().from(classesTable).where(eq(classesTable.id, r.classId ?? -1)).limit(1);
      allResp.push({ ...r, teacherName: teacher?.name ?? "—", className: cls[0]?.name ?? null, classSection: cls[0]?.section ?? null });
    }
  }
  res.json(allResp);
});

// ─── All Duties for a given date (school-wide, for schedule chart) ────────────
router.get("/all-duties", requireAuth, async (req, res) => {
  const sid = schoolId(req);
  const date = String(req.query.date || "");
  if (!date) return res.json([]);

  const allTeachers = await db
    .select({ id: teachersTable.id, name: usersTable.name })
    .from(teachersTable).leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(eq(teachersTable.schoolId, sid));

  const duties = await db.select().from(teacherDutiesTable)
    .where(and(eq(teacherDutiesTable.schoolId, sid), eq(teacherDutiesTable.dutyDate, date)));

  const tMap = new Map(allTeachers.map(t => [t.id!, t.name]));
  res.json(duties.map(d => ({ ...d, teacherName: tMap.get(d.teacherId) ?? "—" })));
});

// ─── Teacher Availability for a given date ───────────────────────────────────
// GET /teacher-mgmt/availability?date=YYYY-MM-DD&schoolId=X
// Returns all teachers with isBusy flag and reason(s)

router.get("/availability", requireAuth, async (req, res) => {
  const sid = schoolId(req);
  const date = String(req.query.date || "");

  // All teachers in school
  const allTeachers = await db
    .select({ id: teachersTable.id, name: usersTable.name })
    .from(teachersTable)
    .leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(eq(teachersTable.schoolId, sid));

  if (!date) {
    return res.json(allTeachers.map(t => ({ teacherId: t.id, name: t.name, isBusy: false, reasons: [] })));
  }

  // Duties on that date
  const duties = await db
    .select({ teacherId: teacherDutiesTable.teacherId, type: teacherDutiesTable.type })
    .from(teacherDutiesTable)
    .where(and(
      eq(teacherDutiesTable.schoolId, sid),
      eq(teacherDutiesTable.dutyDate, date)
    ));

  // Existing active replacements on that date (as replacement teacher)
  const replacements = await db
    .select({ teacherId: teacherReplacementsTable.replacementTeacherId })
    .from(teacherReplacementsTable)
    .where(and(
      eq(teacherReplacementsTable.schoolId, sid),
      eq(teacherReplacementsTable.replacementDate, date),
      eq(teacherReplacementsTable.status, "active")
    ));

  const dutiesMap = new Map<number, string[]>();
  for (const d of duties) {
    if (!dutiesMap.has(d.teacherId)) dutiesMap.set(d.teacherId, []);
    dutiesMap.get(d.teacherId)!.push(d.type);
  }
  const replacementSet = new Set(replacements.map(r => r.teacherId));

  const result = allTeachers.map(t => {
    const reasons: string[] = [];
    if (dutiesMap.has(t.id!)) {
      const types = dutiesMap.get(t.id!)!.map(dt => dt.replace(/_/g, " "));
      reasons.push(`Duty: ${types.join(", ")}`);
    }
    if (replacementSet.has(t.id!)) {
      reasons.push("Already assigned as replacement");
    }
    return {
      teacherId: t.id,
      name: t.name,
      isBusy: reasons.length > 0,
      reasons,
    };
  });

  res.json(result);
});

// ─── Feature 6: Permission Control ──────────────────────────────────────────

router.get("/:teacherId/permissions", requireAuth, async (req, res) => {
  const tid = Number(req.params.teacherId);
  const existing = await db.select().from(teacherPermissionsTable)
    .where(eq(teacherPermissionsTable.teacherId, tid));

  if (existing[0]) { res.json(existing[0]); return; }

  // Return defaults if no record yet
  res.json({
    teacherId: tid, canUploadMarks: true, canUploadHomework: true,
    canContactParents: true, canEditAttendance: true,
  });
});

router.patch("/:teacherId/permissions", requireAuth, adminOnly, async (req, res) => {
  const tid = Number(req.params.teacherId);
  const { canUploadMarks, canUploadHomework, canContactParents, canEditAttendance } = req.body;

  const existing = await db.select().from(teacherPermissionsTable)
    .where(eq(teacherPermissionsTable.teacherId, tid));

  let row;
  if (existing[0]) {
    [row] = await db.update(teacherPermissionsTable)
      .set({ canUploadMarks, canUploadHomework, canContactParents, canEditAttendance, updatedAt: new Date() })
      .where(eq(teacherPermissionsTable.teacherId, tid)).returning();
  } else {
    [row] = await db.insert(teacherPermissionsTable)
      .values({ teacherId: tid, canUploadMarks, canUploadHomework, canContactParents, canEditAttendance })
      .returning();
  }
  res.json(row);
});

// ─── Feature 7: Contract / Renewal Alerts ───────────────────────────────────

router.get("/:teacherId/contract", requireAuth, async (req, res) => {
  const tid = Number(req.params.teacherId);
  const existing = await db.select().from(teacherContractsTable)
    .where(eq(teacherContractsTable.teacherId, tid));
  res.json(existing[0] ?? { teacherId: tid });
});

router.patch("/:teacherId/contract", requireAuth, adminOnly, async (req, res) => {
  const tid = Number(req.params.teacherId);
  const { contractType, contractStartDate, contractEndDate, documentRenewalDate, salaryIncrementDate, notes } = req.body;

  const existing = await db.select().from(teacherContractsTable)
    .where(eq(teacherContractsTable.teacherId, tid));

  let row;
  const vals = { contractType, contractStartDate, contractEndDate, documentRenewalDate, salaryIncrementDate, notes, updatedAt: new Date() };
  if (existing[0]) {
    [row] = await db.update(teacherContractsTable).set(vals)
      .where(eq(teacherContractsTable.teacherId, tid)).returning();
  } else {
    [row] = await db.insert(teacherContractsTable)
      .values({ teacherId: tid, schoolId: schoolId(req), ...vals }).returning();
  }
  res.json(row);
});

// ─── Contract Alerts (school-wide) ──────────────────────────────────────────

router.get("/contract-alerts", requireAuth, async (req, res) => {
  const sid = schoolId(req);
  const contracts = await db
    .select({
      id: teacherContractsTable.id,
      teacherId: teacherContractsTable.teacherId,
      contractEndDate: teacherContractsTable.contractEndDate,
      documentRenewalDate: teacherContractsTable.documentRenewalDate,
      salaryIncrementDate: teacherContractsTable.salaryIncrementDate,
      name: usersTable.name,
      teacherCode: teachersTable.teacherCode,
    })
    .from(teacherContractsTable)
    .leftJoin(teachersTable, eq(teacherContractsTable.teacherId, teachersTable.id))
    .leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(eq(teacherContractsTable.schoolId, sid));

  const today = new Date();
  const in60Days = new Date(today);
  in60Days.setDate(in60Days.getDate() + 60);

  const alerts = contracts.flatMap(c => {
    const result: any[] = [];
    if (c.contractEndDate) {
      const d = new Date(c.contractEndDate);
      if (d <= in60Days) result.push({ ...c, alertType: "contract_expiry", alertDate: c.contractEndDate, daysLeft: Math.ceil((d.getTime() - today.getTime()) / 86400000) });
    }
    if (c.documentRenewalDate) {
      const d = new Date(c.documentRenewalDate);
      if (d <= in60Days) result.push({ ...c, alertType: "document_renewal", alertDate: c.documentRenewalDate, daysLeft: Math.ceil((d.getTime() - today.getTime()) / 86400000) });
    }
    if (c.salaryIncrementDate) {
      const d = new Date(c.salaryIncrementDate);
      if (d <= in60Days) result.push({ ...c, alertType: "salary_increment", alertDate: c.salaryIncrementDate, daysLeft: Math.ceil((d.getTime() - today.getTime()) / 86400000) });
    }
    return result;
  });

  res.json(alerts.sort((a, b) => a.daysLeft - b.daysLeft));
});

// ─── Feature 8: Skill Tags ───────────────────────────────────────────────────

router.patch("/:teacherId/skills", requireAuth, adminOnly, async (req, res) => {
  const { skillTags } = req.body; // array of strings
  const [row] = await db.update(teachersTable)
    .set({ skillTags: JSON.stringify(skillTags), updatedAt: new Date() })
    .where(eq(teachersTable.id, Number(req.params.teacherId)))
    .returning();
  res.json(row);
});

// ─── Feature 9: Meeting Records ─────────────────────────────────────────────

router.get("/meetings", requireAuth, async (req, res) => {
  const sid = schoolId(req);
  const rows = await db.select().from(teacherMeetingsTable)
    .where(eq(teacherMeetingsTable.schoolId, sid))
    .orderBy(desc(teacherMeetingsTable.meetingDate));
  res.json(rows);
});

router.post("/meetings", requireAuth, adminOnly, async (req, res) => {
  const { meetingDate, topic, decisions, attendeeIds } = req.body;
  const [row] = await db.insert(teacherMeetingsTable).values({
    schoolId: schoolId(req),
    meetingDate, topic, decisions,
    attendeeIds: attendeeIds ? JSON.stringify(attendeeIds) : null,
  }).returning();
  res.status(201).json(row);
});

router.put("/meetings/:id", requireAuth, adminOnly, async (req, res) => {
  const { meetingDate, topic, decisions, attendeeIds } = req.body;
  const [row] = await db.update(teacherMeetingsTable).set({
    meetingDate, topic, decisions,
    attendeeIds: attendeeIds ? JSON.stringify(attendeeIds) : null,
    updatedAt: new Date(),
  }).where(eq(teacherMeetingsTable.id, Number(req.params.id))).returning();
  res.json(row);
});

router.delete("/meetings/:id", requireAuth, adminOnly, async (req, res) => {
  await db.delete(teacherMeetingsTable).where(eq(teacherMeetingsTable.id, Number(req.params.id)));
  res.json({ success: true });
});

// ─── Feature 10: Performance / Rankings ─────────────────────────────────────

router.get("/:teacherId/performance", requireAuth, async (req, res) => {
  const rows = await db.select().from(teacherPerformanceTable)
    .where(eq(teacherPerformanceTable.teacherId, Number(req.params.teacherId)))
    .orderBy(desc(teacherPerformanceTable.year), desc(teacherPerformanceTable.month));
  res.json(rows);
});

router.post("/:teacherId/performance", requireAuth, adminOnly, async (req, res) => {
  const { month, year, attendanceScore, disciplineScore, teachingScore, parentFeedbackScore,
    trainingRequired, weakAreas, strengthAreas, notes } = req.body;
  const tid = Number(req.params.teacherId);

  // Upsert: delete then insert same month/year
  await db.delete(teacherPerformanceTable).where(
    and(eq(teacherPerformanceTable.teacherId, tid), eq(teacherPerformanceTable.month, Number(month)), eq(teacherPerformanceTable.year, Number(year)))
  );

  const [row] = await db.insert(teacherPerformanceTable).values({
    teacherId: tid, schoolId: schoolId(req),
    month: Number(month), year: Number(year),
    attendanceScore: Number(attendanceScore) || 0,
    disciplineScore: Number(disciplineScore) || 0,
    teachingScore: Number(teachingScore) || 0,
    parentFeedbackScore: Number(parentFeedbackScore) || 0,
    trainingRequired: !!trainingRequired,
    weakAreas: weakAreas ? JSON.stringify(weakAreas) : null,
    strengthAreas: strengthAreas ? JSON.stringify(strengthAreas) : null,
    notes,
  }).returning();
  res.status(201).json(row);
});

router.get("/rankings", requireAuth, async (req, res) => {
  const sid = schoolId(req);
  const { month, year } = req.query;

  const teachers = await db
    .select({ id: teachersTable.id, name: usersTable.name, teacherCode: teachersTable.teacherCode, subject: teachersTable.subject })
    .from(teachersTable).leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(and(eq(teachersTable.schoolId, sid), eq(teachersTable.isActive, true)));

  let perf: any[] = [];
  if (month && year) {
    perf = await db.select().from(teacherPerformanceTable)
      .where(and(eq(teacherPerformanceTable.schoolId, sid), eq(teacherPerformanceTable.month, Number(month)), eq(teacherPerformanceTable.year, Number(year))));
  }

  const records = await db.select().from(teacherRecordsTable).where(eq(teacherRecordsTable.schoolId, sid));

  const ranked = teachers.map(t => {
    const p = perf.find(x => x.teacherId === t.id);
    const tRecords = records.filter(r => r.teacherId === t.id);
    const warnings = tRecords.filter(r => r.type === "warning" || r.type === "late_coming").length;
    const appreciations = tRecords.filter(r => r.type === "appreciation").length;

    const overallScore = p
      ? Math.round((p.attendanceScore + p.disciplineScore + p.teachingScore + p.parentFeedbackScore) / 4)
      : Math.max(0, 60 + appreciations * 5 - warnings * 10);

    return {
      ...t,
      attendanceScore: p?.attendanceScore ?? null,
      disciplineScore: p?.disciplineScore ?? null,
      teachingScore: p?.teachingScore ?? null,
      parentFeedbackScore: p?.parentFeedbackScore ?? null,
      overallScore,
      warnings, appreciations,
      trainingRequired: p?.trainingRequired ?? false,
      weakAreas: p ? JSON.parse(p.weakAreas || "[]") : [],
      strengthAreas: p ? JSON.parse(p.strengthAreas || "[]") : [],
    };
  });

  res.json(ranked.sort((a, b) => b.overallScore - a.overallScore).map((t, i) => ({ ...t, rank: i + 1 })));
});

export default router;
