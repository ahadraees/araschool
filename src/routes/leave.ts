import { Router } from "express";
import { db, leaveApplicationsTable, studentsTable, usersTable, attendanceTable, staffAttendanceTable, notificationsTable, parentStudentsTable, teachersTable, classesTable } from "@workspace/db";
import { eq, and, desc, or, gte, lte, inArray } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

// ── Helper: get all dates between from and to (inclusive, skip Sundays) ────────
function getDateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const d = new Date(from + "T00:00:00");
  const end = new Date(to + "T00:00:00");
  while (d <= end) {
    if (d.getDay() !== 0) {
      dates.push(d.toISOString().split("T")[0]);
    }
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

// ── Helper: send in-app notification ──────────────────────────────────────────
async function notify(schoolId: number, userId: number, recipientUserId: number, title: string, body: string, type = "info") {
  try {
    await db.insert(notificationsTable).values({
      schoolId, userId, recipientUserId, title, message: body,
      type: type as any, targetRole: "teacher", isRead: false,
    });
  } catch {}
}

// ── POST /apply — submit a leave application ───────────────────────────────────
// Parent/Student → for a student; Teacher → for themselves
router.post("/apply", requireAuth, async (req, res) => {
  const { fromDate, toDate, leaveType, reason, targetStudentId } = req.body;
  const user = req.user!;
  const schoolId = user.schoolId!;

  if (!fromDate || !toDate || !reason) {
    res.status(400).json({ error: "fromDate, toDate, reason are required" }); return;
  }

  let targetType: string;
  let targetStudentIdFinal: number | null = null;
  let targetUserIdFinal: number | null = null;
  let targetName: string;
  let notifyUserIds: number[] = [];

  if (user.role === "parent" || user.role === "student") {
    // Student leave — student can auto-resolve own ID; parent must pass targetStudentId
    let resolvedStudentId: number;
    if (user.role === "student" && !targetStudentId) {
      const selfStudent = await db.select({ id: studentsTable.id }).from(studentsTable)
        .where(and(eq(studentsTable.userId, user.id), eq(studentsTable.schoolId, schoolId))).limit(1);
      if (!selfStudent[0]) { res.status(404).json({ error: "Student record not found for your account" }); return; }
      resolvedStudentId = selfStudent[0].id;
    } else {
      if (!targetStudentId) { res.status(400).json({ error: "targetStudentId required for parent leave application" }); return; }
      resolvedStudentId = Number(targetStudentId);
    }

    const student = await db.select().from(studentsTable)
      .where(and(eq(studentsTable.id, resolvedStudentId), eq(studentsTable.schoolId, schoolId)))
      .limit(1);
    if (!student[0]) { res.status(404).json({ error: "Student not found" }); return; }

    targetType = "student";
    targetStudentIdFinal = resolvedStudentId;
    targetName = student[0].name || "Student";

    // Find class teacher to notify
    if (student[0].classId) {
      const cls = await db.select().from(classesTable).where(eq(classesTable.id, student[0].classId)).limit(1);
      if (cls[0]?.teacherId) {
        const teacher = await db.select().from(teachersTable).where(eq(teachersTable.id, cls[0].teacherId)).limit(1);
        if (teacher[0]?.userId) notifyUserIds.push(teacher[0].userId);
      }
    }
  } else if (user.role === "teacher") {
    // Teacher leave for themselves
    targetType = "staff";
    targetUserIdFinal = user.id;
    targetName = user.name || "Teacher";

    // Notify all admins/sub_admins
    const admins = await db.select({ id: usersTable.id }).from(usersTable)
      .where(and(eq(usersTable.schoolId, schoolId), inArray(usersTable.role, ["admin", "sub_admin"])));
    notifyUserIds = admins.map(a => a.id);
  } else {
    res.status(403).json({ error: "Only parents, students, and teachers can apply for leave" }); return;
  }

  const [app] = await db.insert(leaveApplicationsTable).values({
    schoolId, applicantUserId: user.id, targetType,
    targetStudentId: targetStudentIdFinal,
    targetUserId: targetUserIdFinal,
    targetName, fromDate, toDate,
    leaveType: leaveType || "personal",
    reason, status: "pending",
  }).returning();

  // Notify relevant staff
  const leaveTypeLabel = (leaveType || "personal").charAt(0).toUpperCase() + (leaveType || "personal").slice(1);
  for (const uid of notifyUserIds) {
    await notify(schoolId, user.id, uid,
      `📋 Leave Request — ${targetName}`,
      `${leaveTypeLabel} leave requested: ${fromDate}${fromDate !== toDate ? ` to ${toDate}` : ""}. Reason: ${reason}`,
      "info"
    );
  }

  res.json({ success: true, application: app });
});

// ── GET /pending — admin/sub_admin see all pending; teacher sees student leaves ─
router.get("/pending", requireAuth, async (req, res) => {
  const user = req.user!;
  const schoolId = user.schoolId!;

  let applications: any[];

  if (user.role === "teacher") {
    // Teacher sees pending student leaves for their classes
    const teacherRow = await db.select({ id: teachersTable.id }).from(teachersTable)
      .where(and(eq(teachersTable.userId, user.id), eq(teachersTable.schoolId, schoolId))).limit(1);
    if (!teacherRow[0]) { res.json([]); return; }

    // Get students in teacher's classes
    const myClasses = await db.select({ id: classesTable.id }).from(classesTable)
      .where(and(eq(classesTable.schoolId, schoolId), eq(classesTable.teacherId, teacherRow[0].id)));
    const classIds = myClasses.map(c => c.id);
    if (classIds.length === 0) { res.json([]); return; }

    const classStudents = await db.select({ id: studentsTable.id }).from(studentsTable)
      .where(and(eq(studentsTable.schoolId, schoolId), inArray(studentsTable.classId, classIds)));
    const studentIds = classStudents.map(s => s.id);
    if (studentIds.length === 0) { res.json([]); return; }

    applications = await db.select().from(leaveApplicationsTable)
      .where(and(
        eq(leaveApplicationsTable.schoolId, schoolId),
        eq(leaveApplicationsTable.targetType, "student"),
        eq(leaveApplicationsTable.status, "pending"),
        inArray(leaveApplicationsTable.targetStudentId, studentIds),
      )).orderBy(desc(leaveApplicationsTable.createdAt));
  } else if (["admin", "sub_admin"].includes(user.role)) {
    // Admin/Sub Admin see all pending (student + staff)
    applications = await db.select().from(leaveApplicationsTable)
      .where(and(eq(leaveApplicationsTable.schoolId, schoolId), eq(leaveApplicationsTable.status, "pending")))
      .orderBy(desc(leaveApplicationsTable.createdAt));
  } else {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  // Enrich with applicant name
  const enriched = await Promise.all(applications.map(async app => {
    const applicant = await db.select({ name: usersTable.name, role: usersTable.role })
      .from(usersTable).where(eq(usersTable.id, app.applicantUserId)).limit(1);
    return { ...app, applicantName: applicant[0]?.name, applicantRole: applicant[0]?.role };
  }));

  res.json(enriched);
});

// ── GET /all — all applications (paginated) with filters ──────────────────────
router.get("/all", requireAuth, async (req, res) => {
  const user = req.user!;
  const schoolId = user.schoolId!;
  const { status, targetType } = req.query as Record<string, string>;

  const conditions: any[] = [eq(leaveApplicationsTable.schoolId, schoolId)];
  if (status) conditions.push(eq(leaveApplicationsTable.status, status));
  if (targetType) conditions.push(eq(leaveApplicationsTable.targetType, targetType));

  if (user.role === "teacher") {
    // Teacher sees their own staff applications
    conditions.push(eq(leaveApplicationsTable.applicantUserId, user.id));
  } else if (user.role === "parent" || user.role === "student") {
    conditions.push(eq(leaveApplicationsTable.applicantUserId, user.id));
  }

  const apps = await db.select().from(leaveApplicationsTable)
    .where(and(...conditions))
    .orderBy(desc(leaveApplicationsTable.createdAt))
    .limit(100);

  const enriched = await Promise.all(apps.map(async app => {
    const applicant = await db.select({ name: usersTable.name, role: usersTable.role })
      .from(usersTable).where(eq(usersTable.id, app.applicantUserId)).limit(1);
    let approverName: string | null = null;
    if (app.approvedByUserId) {
      const approver = await db.select({ name: usersTable.name }).from(usersTable)
        .where(eq(usersTable.id, app.approvedByUserId)).limit(1);
      approverName = approver[0]?.name || null;
    }
    return { ...app, applicantName: applicant[0]?.name, applicantRole: applicant[0]?.role, approverName };
  }));

  res.json(enriched);
});

// ── PATCH /:id/approve — approve a leave application ─────────────────────────
router.patch("/:id/approve", requireAuth, async (req, res) => {
  const user = req.user!;
  const schoolId = user.schoolId!;
  const appId = Number(req.params.id);

  const [app] = await db.select().from(leaveApplicationsTable)
    .where(and(eq(leaveApplicationsTable.id, appId), eq(leaveApplicationsTable.schoolId, schoolId)));
  if (!app) { res.status(404).json({ error: "Application not found" }); return; }
  if (app.status !== "pending") { res.status(400).json({ error: "Application already processed" }); return; }

  // Permission check
  if (app.targetType === "student" && user.role !== "teacher" && !["admin","sub_admin"].includes(user.role)) {
    res.status(403).json({ error: "Only teachers, admin, or sub admin can approve student leaves" }); return;
  }
  if (app.targetType === "staff" && !["admin","sub_admin"].includes(user.role)) {
    res.status(403).json({ error: "Only admin or sub admin can approve staff leaves" }); return;
  }

  // Update status
  const now = new Date();
  await db.update(leaveApplicationsTable)
    .set({ status: "approved", approvedByUserId: user.id, approvedAt: now })
    .where(eq(leaveApplicationsTable.id, appId));

  // Mark attendance as "leave" for the date range
  const dates = getDateRange(app.fromDate, app.toDate);

  if (app.targetType === "student" && app.targetStudentId) {
    const studentId = app.targetStudentId;
    const student = await db.select().from(studentsTable).where(eq(studentsTable.id, studentId)).limit(1);
    const classId = student[0]?.classId;

    for (const dateStr of dates) {
      if (!classId) continue;
      const existing = await db.select({ id: attendanceTable.id }).from(attendanceTable)
        .where(and(eq(attendanceTable.studentId, studentId), eq(attendanceTable.date, dateStr as any))).limit(1);
      if (existing[0]) {
        await db.update(attendanceTable).set({ status: "leave" as any }).where(eq(attendanceTable.id, existing[0].id));
      } else {
        await db.insert(attendanceTable).values({
          schoolId, studentId, classId, date: dateStr as any, status: "leave" as any,
          markedByUserId: user.id,
        });
      }
    }

    // Notify parent/student applicant
    await notify(schoolId, user.id, app.applicantUserId,
      `✅ Leave Approved — ${app.targetName}`,
      `Leave from ${app.fromDate}${app.fromDate !== app.toDate ? ` to ${app.toDate}` : ""} has been approved by ${user.name || "teacher"}.`,
      "success"
    );
  } else if (app.targetType === "staff" && app.targetUserId) {
    const staffUserId = app.targetUserId;
    for (const dateStr of dates) {
      const existing = await db.select({ id: staffAttendanceTable.id }).from(staffAttendanceTable)
        .where(and(
          eq(staffAttendanceTable.userId, staffUserId),
          eq(staffAttendanceTable.date, dateStr as any),
          eq(staffAttendanceTable.schoolId, schoolId),
        )).limit(1);
      const staffUser = await db.select({ role: usersTable.role }).from(usersTable)
        .where(eq(usersTable.id, staffUserId)).limit(1);
      const staffType = staffUser[0]?.role || "teacher";

      if (existing[0]) {
        await db.update(staffAttendanceTable).set({ status: "leave" }).where(eq(staffAttendanceTable.id, existing[0].id));
      } else {
        await db.insert(staffAttendanceTable).values({
          schoolId, userId: staffUserId, staffType, date: dateStr as any, status: "leave",
          createdBy: user.id,
        });
      }
    }

    // Notify teacher applicant
    await notify(schoolId, user.id, app.applicantUserId,
      `✅ Leave Approved — ${app.targetName}`,
      `Your leave from ${app.fromDate}${app.fromDate !== app.toDate ? ` to ${app.toDate}` : ""} has been approved by ${user.name || "admin"}.`,
      "success"
    );
  }

  res.json({ success: true, datesMarked: dates.length });
});

// ── PATCH /:id/reject — reject a leave application ───────────────────────────
router.patch("/:id/reject", requireAuth, async (req, res) => {
  const user = req.user!;
  const schoolId = user.schoolId!;
  const appId = Number(req.params.id);
  const { rejectionNote } = req.body;

  const [app] = await db.select().from(leaveApplicationsTable)
    .where(and(eq(leaveApplicationsTable.id, appId), eq(leaveApplicationsTable.schoolId, schoolId)));
  if (!app) { res.status(404).json({ error: "Application not found" }); return; }
  if (app.status !== "pending") { res.status(400).json({ error: "Application already processed" }); return; }

  // Permission check
  if (app.targetType === "student" && user.role !== "teacher" && !["admin","sub_admin"].includes(user.role)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  if (app.targetType === "staff" && !["admin","sub_admin"].includes(user.role)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  await db.update(leaveApplicationsTable)
    .set({ status: "rejected", approvedByUserId: user.id, approvedAt: new Date(), rejectionNote: rejectionNote || null })
    .where(eq(leaveApplicationsTable.id, appId));

  // Notify applicant of rejection
  await notify(schoolId, user.id, app.applicantUserId,
    `❌ Leave Rejected — ${app.targetName}`,
    `Your leave request for ${app.fromDate}${app.fromDate !== app.toDate ? ` to ${app.toDate}` : ""} was rejected.${rejectionNote ? ` Reason: ${rejectionNote}` : ""}`,
    "warning"
  );

  res.json({ success: true });
});

// ── GET /my-students — parent/teacher: list students to apply leave for ────────
router.get("/my-students", requireAuth, async (req, res) => {
  const user = req.user!;
  const schoolId = user.schoolId!;

  if (user.role === "parent") {
    const links = await db.select({ studentId: parentStudentsTable.studentId })
      .from(parentStudentsTable).where(eq(parentStudentsTable.parentUserId, user.id));
    const ids = links.map(l => l.studentId);
    if (ids.length === 0) { res.json([]); return; }
    const students = await db.select({ id: studentsTable.id, name: studentsTable.name, classId: studentsTable.classId, admissionNumber: studentsTable.admissionNumber })
      .from(studentsTable).where(and(inArray(studentsTable.id, ids), eq(studentsTable.schoolId, schoolId)));
    res.json(students);
  } else if (user.role === "student") {
    const students = await db.select({ id: studentsTable.id, name: studentsTable.name, classId: studentsTable.classId, admissionNumber: studentsTable.admissionNumber })
      .from(studentsTable).where(and(eq(studentsTable.userId, user.id), eq(studentsTable.schoolId, schoolId)));
    res.json(students);
  } else {
    res.json([]);
  }
});

export default router;
