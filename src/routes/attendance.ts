import { Router } from "express";
import { db, attendanceTable, studentsTable, classesTable, teachersTable, teacherClassesTable, notificationsTable, parentStudentsTable, staffAttendanceTable, usersTable, smsSettingsTable } from "@workspace/db";
import { eq, and, sql, inArray, gte, lte, notInArray, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { sendSmsOrWhatsapp } from "./sms-settings.js";

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────
const ATTENDANCE_START_HOUR = 8;      // 8:00 AM
const LATE_THRESHOLD_HOUR   = 9;
const LATE_THRESHOLD_MIN    = 30;     // 9:30 AM → after this = "late"

// ── Helper: resolve class IDs allowed for the current user ───────────────────
async function getAllowedClassIds(userId: number, schoolId: number | null, role: string): Promise<number[] | null> {
  if (role !== "teacher") return null;
  const teacherRow = await db
    .select({ id: teachersTable.id })
    .from(teachersTable)
    .where(and(eq(teachersTable.userId, userId), schoolId ? eq(teachersTable.schoolId, schoolId) : sql`1=1`));
  if (!teacherRow[0]) return [];
  const tid = teacherRow[0].id;

  const primary = await db
    .select({ id: classesTable.id })
    .from(classesTable)
    .where(and(eq(classesTable.teacherId, tid), schoolId ? eq(classesTable.schoolId, schoolId) : sql`1=1`));

  const extra = await db
    .select({ classId: teacherClassesTable.classId })
    .from(teacherClassesTable)
    .where(eq(teacherClassesTable.teacherId, tid));

  const ids = [...new Set([...primary.map(r => r.id), ...extra.map(r => r.classId)])];
  return ids;
}

// ── Helper: notify parents of a student ──────────────────────────────────────
async function notifyParents(
  studentId: number,
  studentName: string,
  schoolId: number,
  status: "absent" | "late",
  date: string
) {
  try {
    const parentLinks = await db
      .select({ parentUserId: parentStudentsTable.parentUserId })
      .from(parentStudentsTable)
      .where(eq(parentStudentsTable.studentId, studentId));

    if (parentLinks.length === 0) return;

    const dateFormatted = new Date(date).toLocaleDateString("en-PK", {
      weekday: "long", day: "numeric", month: "long", year: "numeric"
    });

    const title   = status === "absent"
      ? `Absence Alert — ${studentName}`
      : `Late Arrival — ${studentName}`;
    const message = status === "absent"
      ? `Your child ${studentName} was marked ABSENT on ${dateFormatted}. Please contact school if this is unexpected.`
      : `Your child ${studentName} arrived LATE on ${dateFormatted}. Please ensure timely attendance.`;

    await db.insert(notificationsTable).values(
      parentLinks.map(p => ({
        schoolId,
        userId:          p.parentUserId,
        recipientUserId: p.parentUserId,
        targetStudentId: studentId,
        title,
        message,
        type: status === "absent" ? "warning" : "info",
        targetRole: "parent",
      }))
    );

    // ── Auto WhatsApp/SMS to parent ───────────────────────────────────────
    if (status === "absent") {
      const smsSettings = await db.query.smsSettingsTable.findFirst({
        where: eq(smsSettingsTable.schoolId, schoolId),
      });
      if (smsSettings?.notifyAbsent && smsSettings.smsEnabled) {
        const parentUserIds = parentLinks.map(p => p.parentUserId).filter(Boolean) as number[];
        if (parentUserIds.length > 0) {
          const parents = await db.select({ phone: usersTable.phone })
            .from(usersTable).where(inArray(usersTable.id, parentUserIds));
          for (const parent of parents) {
            if (parent.phone) {
              await sendSmsOrWhatsapp(smsSettings, parent.phone, message).catch(() => null);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("notifyParents error:", err);
  }
}

// ── Helper: run auto-absent for a school (called by cron & manual endpoint) ──
export async function runAutoAbsent(schoolId?: number) {
  const today = new Date().toISOString().split("T")[0];

  const studentConditions: any[] = [eq(studentsTable.isActive, true)];
  if (schoolId) studentConditions.push(eq(studentsTable.schoolId, schoolId));

  const allStudents = await db
    .select({
      id:      studentsTable.id,
      name:    studentsTable.name,
      classId: studentsTable.classId,
      schoolId: studentsTable.schoolId,
    })
    .from(studentsTable)
    .where(and(...studentConditions));

  const studentsWithClass = allStudents.filter(s => s.classId !== null);
  if (studentsWithClass.length === 0) return { marked: 0 };

  const studentIds = studentsWithClass.map(s => s.id);

  const alreadyMarked = await db
    .select({ studentId: attendanceTable.studentId })
    .from(attendanceTable)
    .where(
      and(
        eq(attendanceTable.date, today as unknown as Date),
        inArray(attendanceTable.studentId, studentIds)
      )
    );

  const markedIds = new Set(alreadyMarked.map(r => r.studentId));
  const unmarked  = studentsWithClass.filter(s => !markedIds.has(s.id));

  if (unmarked.length === 0) return { marked: 0 };

  await db.insert(attendanceTable).values(
    unmarked.map(s => ({
      studentId: s.id,
      classId:   s.classId!,
      date:      today,
      status:    "absent",
      remarks:   "Auto-marked absent (not scanned by 9:30 AM)",
      markedBy:  null,
    }))
  );

  // Send parent notifications
  for (const s of unmarked) {
    await notifyParents(s.id, s.name || "Student", s.schoolId || schoolId || 0, "absent", today);
  }

  return { marked: unmarked.length };
}

// ── GET /summary ──────────────────────────────────────────────────────────────
router.get("/summary", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId;
  const month = req.query.month ? Number(req.query.month) : new Date().getMonth() + 1;
  const year  = req.query.year  ? Number(req.query.year)  : new Date().getFullYear();
  const classId = req.query.classId ? Number(req.query.classId) : undefined;

  const today = new Date().toISOString().split("T")[0];

  const allowedIds = await getAllowedClassIds(req.user!.id, schoolId, req.user!.role);
  const effectiveClassId = classId ??
    (allowedIds && allowedIds.length === 1 ? allowedIds[0] : undefined);

  const studentConditions: ReturnType<typeof and>[] = [eq(studentsTable.isActive, true)];
  if (schoolId) studentConditions.push(eq(studentsTable.schoolId, schoolId));
  if (effectiveClassId) studentConditions.push(eq(studentsTable.classId, effectiveClassId));
  else if (allowedIds && allowedIds.length > 0) studentConditions.push(inArray(studentsTable.classId, allowedIds));

  const totalStudentsQ = await db.select({ count: sql<number>`count(*)` })
    .from(studentsTable)
    .where(and(...studentConditions));

  const attConditions: ReturnType<typeof and>[] = [eq(attendanceTable.date, today as unknown as Date)];
  if (effectiveClassId) attConditions.push(eq(attendanceTable.classId, effectiveClassId));
  else if (allowedIds && allowedIds.length > 0) attConditions.push(inArray(attendanceTable.classId, allowedIds));

  const todayRecords = await db
    .select({ status: attendanceTable.status, count: sql<number>`count(*)` })
    .from(attendanceTable)
    .where(and(...attConditions))
    .groupBy(attendanceTable.status);

  const todayMap = Object.fromEntries(todayRecords.map(r => [r.status, Number(r.count)]));

  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const lastDay     = Math.min(daysInMonth, new Date().getDate());
  const monthEnd    = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const monthConditions: ReturnType<typeof and>[] = [
    sql`${attendanceTable.date} >= ${monthStart}::date`,
    sql`${attendanceTable.date} <= ${monthEnd}::date`,
  ];
  if (effectiveClassId) monthConditions.push(eq(attendanceTable.classId, effectiveClassId));
  else if (allowedIds && allowedIds.length > 0) monthConditions.push(inArray(attendanceTable.classId, allowedIds));

  const monthlyRaw = await db
    .select({
      date:   sql<string>`to_char(${attendanceTable.date}, 'YYYY-MM-DD')`,
      status: attendanceTable.status,
      count:  sql<number>`count(*)`,
    })
    .from(attendanceTable)
    .where(and(...monthConditions))
    .groupBy(sql`${attendanceTable.date}`, attendanceTable.status);

  const dateMap = new Map<string, { present: number; absent: number; late: number }>();
  monthlyRaw.forEach(r => {
    if (!dateMap.has(r.date)) dateMap.set(r.date, { present: 0, absent: 0, late: 0 });
    const d = dateMap.get(r.date)!;
    if (r.status === "present") d.present += Number(r.count);
    else if (r.status === "absent") d.absent += Number(r.count);
    else if (r.status === "late")   d.late   += Number(r.count);
  });

  const monthlyData = Array.from(dateMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts }));

  res.json({
    totalStudents: Number(totalStudentsQ[0].count),
    presentToday:  todayMap.present || 0,
    absentToday:   todayMap.absent  || 0,
    lateToday:     todayMap.late    || 0,
    monthlyData,
  });
});

// ── GET /range — date-range attendance grid (3-day / week / month) ────────────
router.get("/range", requireAuth, async (req, res) => {
  const classId = req.query.classId ? Number(req.query.classId) : undefined;
  const from    = req.query.from as string | undefined;
  const to      = req.query.to   as string | undefined;
  const schoolId = req.user!.schoolId;

  if (!classId || !from || !to) {
    res.status(400).json({ error: "classId, from, to required" });
    return;
  }

  const students = await db
    .select({ id: studentsTable.id, name: studentsTable.name, rollNumber: studentsTable.rollNumber })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.classId, classId),
        eq(studentsTable.isActive, true),
        schoolId ? eq(studentsTable.schoolId, schoolId) : sql`1=1`
      )
    )
    .orderBy(studentsTable.rollNumber, studentsTable.name);

  if (students.length === 0) {
    res.json({ students: [], dates: [], records: {} });
    return;
  }

  const records = await db
    .select({
      studentId: attendanceTable.studentId,
      date:      sql<string>`to_char(${attendanceTable.date}, 'YYYY-MM-DD')`,
      status:    attendanceTable.status,
    })
    .from(attendanceTable)
    .where(
      and(
        eq(attendanceTable.classId, classId),
        sql`${attendanceTable.date} >= ${from}::date`,
        sql`${attendanceTable.date} <= ${to}::date`,
      )
    );

  // Build date list
  const dateSet = new Set<string>();
  const cur = new Date(from);
  const end = new Date(to);
  while (cur <= end) {
    dateSet.add(cur.toISOString().split("T")[0]);
    cur.setDate(cur.getDate() + 1);
  }
  const dates = Array.from(dateSet).sort();

  // Build map: studentId → { date → status }
  const statusMap: Record<number, Record<string, string>> = {};
  for (const s of students) statusMap[s.id] = {};
  for (const r of records) {
    if (statusMap[r.studentId]) statusMap[r.studentId][r.date] = r.status;
  }

  res.json({ students, dates, records: statusMap });
});

// ── GET / ─────────────────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  const classId   = req.query.classId   ? Number(req.query.classId)   : undefined;
  const studentId = req.query.studentId ? Number(req.query.studentId) : undefined;
  const date      = req.query.date as string | undefined;

  const conditions: ReturnType<typeof eq>[] = [];
  if (classId)   conditions.push(eq(attendanceTable.classId,   classId));
  if (studentId) conditions.push(eq(attendanceTable.studentId, studentId));
  if (date)      conditions.push(eq(attendanceTable.date, date as unknown as Date));

  const records = await db
    .select({
      id:          attendanceTable.id,
      studentId:   attendanceTable.studentId,
      classId:     attendanceTable.classId,
      date:        attendanceTable.date,
      status:      attendanceTable.status,
      remarks:     attendanceTable.remarks,
      markedBy:    attendanceTable.markedBy,
      studentName: studentsTable.name,
      createdAt:   attendanceTable.createdAt,
    })
    .from(attendanceTable)
    .leftJoin(studentsTable, eq(attendanceTable.studentId, studentsTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  res.json(records);
});

// ── POST / — manual mark attendance ──────────────────────────────────────────
router.post("/", requireAuth, async (req, res) => {
  const { classId, date, records } = req.body;

  if (!classId || !date || !records || !Array.isArray(records)) {
    res.status(400).json({ error: "Bad Request", message: "classId, date, and records required" });
    return;
  }

  if (req.user!.role === "teacher") {
    const allowedIds = await getAllowedClassIds(req.user!.id, req.user!.schoolId, "teacher");
    if (allowedIds !== null && !allowedIds.includes(Number(classId))) {
      res.status(403).json({ error: "Forbidden", message: "You can only mark attendance for your assigned classes." });
      return;
    }
  }

  // Delete existing records for this class+date
  await db.delete(attendanceTable).where(and(
    eq(attendanceTable.classId, classId),
    eq(attendanceTable.date, date as unknown as Date),
  ));

  if (records.length > 0) {
    await db.insert(attendanceTable).values(
      records.map((r: { studentId: number; status: string; remarks?: string }) => ({
        studentId: r.studentId,
        classId,
        date,
        status:   r.status,
        remarks:  r.remarks,
        markedBy: req.user!.id,
      }))
    );

    // Notify parents for absent/late students
    const schoolId = req.user!.schoolId;
    if (schoolId) {
      const studentIds = records.filter(r => r.status === "absent" || r.status === "late").map(r => r.studentId);
      if (studentIds.length > 0) {
        const studentInfo = await db
          .select({ id: studentsTable.id, name: studentsTable.name })
          .from(studentsTable)
          .where(inArray(studentsTable.id, studentIds));

        for (const si of studentInfo) {
          const rec = records.find(r => r.studentId === si.id);
          if (rec) {
            await notifyParents(si.id, si.name || "Student", schoolId, rec.status as "absent" | "late", date);
          }
        }
      }
    }
  }

  res.json({ success: true, message: "Attendance marked successfully" });
});

// ── POST /auto-absent — mark all unmarked students absent (cron trigger) ──────
router.post("/auto-absent", requireAuth, async (req, res) => {
  if (!["admin", "sub_admin", "super_admin"].includes(req.user!.role)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const result = await runAutoAbsent(req.user!.schoolId ?? undefined);
  res.json({ success: true, ...result });
});

// ── GET /today-arrivals — Kiosk: today's present students ────────────────────
router.get("/today-arrivals", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId;
  const today = new Date().toISOString().split("T")[0];

  const rows = await db
    .select({
      studentId:       attendanceTable.studentId,
      name:            studentsTable.name,
      admissionNumber: studentsTable.admissionNumber,
      rollNumber:      studentsTable.rollNumber,
      photo:           studentsTable.photo,
      status:          attendanceTable.status,
      className:       classesTable.name,
      classSection:    classesTable.section,
      markedAt:        attendanceTable.createdAt,
    })
    .from(attendanceTable)
    .leftJoin(studentsTable, eq(attendanceTable.studentId, studentsTable.id))
    .leftJoin(classesTable, eq(attendanceTable.classId, classesTable.id))
    .where(
      and(
        eq(attendanceTable.date, today as unknown as Date),
        schoolId ? eq(studentsTable.schoolId, schoolId) : sql`1=1`
      )
    )
    .orderBy(sql`${attendanceTable.createdAt} DESC`);

  const totalQ = await db
    .select({ count: sql<number>`count(*)` })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.isActive, true),
        schoolId ? eq(studentsTable.schoolId, schoolId) : sql`1=1`
      )
    );

  res.json({
    arrivals: rows.map(r => ({
      studentId:       r.studentId,
      name:            r.name,
      admissionNumber: r.admissionNumber,
      rollNumber:      r.rollNumber,
      photo:           r.photo,
      status:          r.status,
      className:       r.className ? `${r.className}${r.classSection ? ` (${r.classSection})` : ""}` : "—",
      markedAt:        r.markedAt,
    })),
    presentCount:  rows.filter(r => r.status === "present").length,
    lateCount:     rows.filter(r => r.status === "late").length,
    totalStudents: Number(totalQ[0]?.count ?? 0),
  });
});

// ── POST /scan — Barcode Scan Attendance (time-aware: before 9:30 = present, after = late) ────
router.post("/scan", requireAuth, async (req, res) => {
  try {
    const { scanCode, date } = req.body;

    if (!scanCode || typeof scanCode !== "string") {
      res.status(400).json({ error: "scanCode is required" });
      return;
    }

    const todayDate = date || new Date().toISOString().split("T")[0];
    const code      = scanCode.trim();

    // Determine status based on time
    const now     = new Date();
    const hour    = now.getHours();
    const minute  = now.getMinutes();
    const isLate  = (hour > LATE_THRESHOLD_HOUR) || (hour === LATE_THRESHOLD_HOUR && minute >= LATE_THRESHOLD_MIN);
    const scanStatus: "present" | "late" = isLate ? "late" : "present";

    const students = await db
      .select({
        id:              studentsTable.id,
        name:            studentsTable.name,
        classId:         studentsTable.classId,
        rollNumber:      studentsTable.rollNumber,
        admissionNumber: studentsTable.admissionNumber,
        schoolId:        studentsTable.schoolId,
        photo:           studentsTable.photo,
        fatherName:      studentsTable.fatherName,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.admissionNumber, code),
          eq(studentsTable.isActive, true),
          req.user!.schoolId ? eq(studentsTable.schoolId, req.user!.schoolId) : sql`1=1`
        )
      )
      .limit(1);

    if (!students[0]) {
      res.status(404).json({ error: "not_found", message: `No student found with ID: ${code}` });
      return;
    }

    const student = students[0];

    if (!student.classId) {
      res.status(400).json({ error: "no_class", message: `${student.name} is not assigned to any class.` });
      return;
    }

    // Check if already marked today
    const existing = await db
      .select({ id: attendanceTable.id, status: attendanceTable.status, createdAt: attendanceTable.createdAt })
      .from(attendanceTable)
      .where(
        and(
          eq(attendanceTable.studentId, student.id),
          eq(attendanceTable.date, todayDate as unknown as Date)
        )
      )
      .limit(1);

    const cls = await db
      .select({ name: classesTable.name, section: classesTable.section })
      .from(classesTable)
      .where(eq(classesTable.id, student.classId))
      .limit(1);

    const className = cls[0] ? `${cls[0].name}${cls[0].section ? ` (${cls[0].section})` : ""}` : "—";

    if (existing[0]) {
      res.json({
        status: "already_marked",
        student: {
          id: student.id, name: student.name,
          admissionNumber: student.admissionNumber,
          rollNumber: student.rollNumber,
          fatherName: student.fatherName,
          photo: student.photo,
          className,
          attendanceStatus: existing[0].status,
          markedAt: existing[0].createdAt?.toISOString(),
        },
      });
      return;
    }

    // Insert attendance
    await db.insert(attendanceTable).values({
      studentId: student.id,
      classId:   student.classId,
      date:      todayDate,
      status:    scanStatus,
      remarks:   isLate ? "Scanned after 9:30 AM" : undefined,
      markedBy:  req.user!.id,
    });

    // Notify parents if late
    if (isLate && student.schoolId) {
      await notifyParents(student.id, student.name || "Student", student.schoolId, "late", todayDate);
    }

    res.json({
      status:    "marked",
      scanStatus,
      isLate,
      student: {
        id: student.id, name: student.name,
        admissionNumber: student.admissionNumber,
        rollNumber: student.rollNumber,
        fatherName: student.fatherName,
        photo: student.photo,
        className,
        attendanceStatus: scanStatus,
        markedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("Scan attendance error:", err);
    res.status(500).json({ error: "server_error", message: "Something went wrong. Please try again." });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// STAFF ATTENDANCE
// ════════════════════════════════════════════════════════════════════════════

// ── Helper: notify a staff member (teacher/accountant) ────────────────────────
async function notifyStaff(
  staffUserId: number,
  staffName:   string,
  schoolId:    number,
  status:      "absent" | "late",
  date:        string
) {
  try {
    const dateFormatted = new Date(date).toLocaleDateString("en-PK", {
      weekday: "long", day: "numeric", month: "long", year: "numeric"
    });
    const title   = status === "absent" ? `You were marked Absent — ${dateFormatted}` : `Late Arrival Recorded — ${dateFormatted}`;
    const message = status === "absent"
      ? `Your attendance for ${dateFormatted} has been recorded as ABSENT. Please contact administration if this is incorrect.`
      : `Your arrival on ${dateFormatted} was recorded as LATE. Please ensure timely attendance.`;

    await db.insert(notificationsTable).values({
      schoolId,
      userId:          staffUserId,
      recipientUserId: staffUserId,
      title,
      message,
      type:       status === "absent" ? "warning" : "info",
      targetRole: "teacher",
    });
  } catch (err) {
    console.error("notifyStaff error:", err);
  }
}

// ── Helper: auto-absent staff (called by cron & manual endpoint) ──────────────
export async function runAutoAbsentStaff(schoolId?: number) {
  const today = new Date().toISOString().split("T")[0];

  const staffRoles = ["teacher", "accountant", "sub_admin"];
  const conditions: any[] = [
    eq(usersTable.isActive, true),
    inArray(usersTable.role, staffRoles),
  ];
  if (schoolId) conditions.push(eq(usersTable.schoolId, schoolId));

  const allStaff = await db
    .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role, schoolId: usersTable.schoolId })
    .from(usersTable)
    .where(and(...conditions));

  if (allStaff.length === 0) return { marked: 0 };

  const staffIds = allStaff.map(s => s.id);

  const alreadyMarked = await db
    .select({ userId: staffAttendanceTable.userId })
    .from(staffAttendanceTable)
    .where(and(
      eq(staffAttendanceTable.date, today as any),
      inArray(staffAttendanceTable.userId, staffIds),
    ));

  const markedSet = new Set(alreadyMarked.map(r => r.userId));
  const unmarked  = allStaff.filter(s => !markedSet.has(s.id));

  if (unmarked.length === 0) return { marked: 0 };

  await db.insert(staffAttendanceTable).values(
    unmarked.map(s => ({
      schoolId: s.schoolId ?? schoolId ?? 0,
      userId:   s.id,
      staffType: s.role,
      status:   "absent",
      date:     today,
      scanTime: null,
      notes:    "Auto-marked absent (not scanned by 9:30 AM)",
    }))
  );

  for (const s of unmarked) {
    if (s.schoolId) await notifyStaff(s.id, s.name || "Staff", s.schoolId, "absent", today);
  }

  return { marked: unmarked.length };
}

// ── GET /staff — list staff with today's attendance ───────────────────────────
router.get("/staff", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const date     = (req.query.date as string) || new Date().toISOString().split("T")[0];

  const staffList = await db
    .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role, email: usersTable.email })
    .from(usersTable)
    .where(and(
      eq(usersTable.schoolId, schoolId),
      eq(usersTable.isActive, true),
      inArray(usersTable.role, ["teacher", "accountant", "sub_admin"]),
    ));

  if (staffList.length === 0) { res.json([]); return; }

  const staffIds = staffList.map(s => s.id);

  // Get attendance records for this date
  const attRecords = await db
    .select()
    .from(staffAttendanceTable)
    .where(and(
      eq(staffAttendanceTable.schoolId, schoolId),
      eq(staffAttendanceTable.date, date as any),
      inArray(staffAttendanceTable.userId, staffIds),
    ));

  const attMap = new Map(attRecords.map(r => [r.userId, r]));

  // Get teacher profile for photo/code
  const teachers = await db
    .select({ userId: teachersTable.userId, teacherCode: teachersTable.teacherCode, photo: teachersTable.photo, phone: teachersTable.phone })
    .from(teachersTable)
    .where(and(eq(teachersTable.schoolId, schoolId), eq(teachersTable.isActive, true)));

  const teacherMap = new Map(teachers.map(t => [t.userId, t]));

  res.json(staffList.map(s => {
    const att     = attMap.get(s.id);
    const profile = teacherMap.get(s.id);
    return {
      userId:      s.id,
      name:        s.name,
      role:        s.role,
      email:       s.email,
      teacherCode: profile?.teacherCode ?? null,
      photo:       profile?.photo ?? null,
      phone:       profile?.phone ?? null,
      status:      att?.status ?? null,
      scanTime:    att?.scanTime ?? null,
      attendanceId: att?.id ?? null,
    };
  }));
});

// ── GET /staff/range — range history for staff ────────────────────────────────
router.get("/staff/range", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId!;
  const { from, to, userId } = req.query as Record<string, string>;

  const conditions: any[] = [eq(staffAttendanceTable.schoolId, schoolId)];
  if (from) conditions.push(gte(staffAttendanceTable.date, from as any));
  if (to)   conditions.push(lte(staffAttendanceTable.date, to   as any));
  if (userId) conditions.push(eq(staffAttendanceTable.userId, Number(userId)));

  const rows = await db
    .select()
    .from(staffAttendanceTable)
    .where(and(...conditions))
    .orderBy(desc(staffAttendanceTable.date));

  res.json(rows);
});

// ── POST /staff/mark — mark single staff member ───────────────────────────────
router.post("/staff/mark", requireAuth, async (req, res) => {
  const { userId, status, date, notes } = req.body;
  const schoolId  = req.user!.schoolId!;
  const dateStr   = date || new Date().toISOString().split("T")[0];
  const now       = new Date();
  const scanHHMM  = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

  const staffUser = await db
    .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role, schoolId: usersTable.schoolId })
    .from(usersTable)
    .where(and(eq(usersTable.id, Number(userId)), eq(usersTable.isActive, true)))
    .limit(1);

  if (!staffUser[0]) { res.status(404).json({ error: "User not found" }); return; }
  const staff = staffUser[0];

  // Determine if late (based on current time)
  const isLate = !date && (now.getHours() > LATE_THRESHOLD_HOUR ||
    (now.getHours() === LATE_THRESHOLD_HOUR && now.getMinutes() >= LATE_THRESHOLD_MIN));
  const finalStatus = status || (isLate ? "late" : "present");

  // Upsert attendance
  const existing = await db
    .select({ id: staffAttendanceTable.id })
    .from(staffAttendanceTable)
    .where(and(
      eq(staffAttendanceTable.userId, Number(userId)),
      eq(staffAttendanceTable.date, dateStr as any),
      eq(staffAttendanceTable.schoolId, schoolId),
    ))
    .limit(1);

  let attRecord;
  if (existing[0]) {
    [attRecord] = await db
      .update(staffAttendanceTable)
      .set({ status: finalStatus, scanTime: scanHHMM, notes: notes ?? null })
      .where(eq(staffAttendanceTable.id, existing[0].id))
      .returning();
  } else {
    [attRecord] = await db.insert(staffAttendanceTable).values({
      schoolId,
      userId:    Number(userId),
      staffType: staff.role,
      status:    finalStatus,
      date:      dateStr,
      scanTime:  scanHHMM,
      notes:     notes ?? null,
      createdBy: req.user!.id,
    }).returning();
  }

  // Notify staff if late or absent
  if ((finalStatus === "late" || finalStatus === "absent") && staff.schoolId) {
    await notifyStaff(staff.id, staff.name || "Staff", staff.schoolId, finalStatus as "late"|"absent", dateStr);
  }

  res.json({ success: true, attendance: attRecord, status: finalStatus, isLate });
});

// ── POST /auto-absent-staff — trigger auto-absent for staff ───────────────────
router.post("/auto-absent-staff", requireAuth, async (req, res) => {
  const schoolId = req.user!.schoolId ?? undefined;
  const result   = await runAutoAbsentStaff(schoolId);
  res.json({ success: true, ...result });
});

export default router;
