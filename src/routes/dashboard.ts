import { Router } from "express";
import { db, studentsTable, teachersTable, classesTable, attendanceTable, feesTable, examsTable, notificationsTable } from "@workspace/db";
import { eq, and, sql, gte, lte } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

router.get("/stats", requireAuth, async (req, res) => {
  const schoolId = req.query.schoolId ? Number(req.query.schoolId) : req.user!.schoolId;

  const conditions = schoolId ? [eq(studentsTable.schoolId, schoolId)] : [];

  const [studentCount] = await db.select({ count: sql<number>`count(*)` })
    .from(studentsTable).where(and(eq(studentsTable.isActive, true), ...conditions));

  const teacherConditions = schoolId ? [eq(teachersTable.schoolId, schoolId), eq(teachersTable.isActive, true)] : [eq(teachersTable.isActive, true)];
  const [teacherCount] = await db.select({ count: sql<number>`count(*)` })
    .from(teachersTable).where(and(...teacherConditions));

  const classConditions = schoolId ? [eq(classesTable.schoolId, schoolId)] : [];
  const [classCount] = await db.select({ count: sql<number>`count(*)` })
    .from(classesTable).where(and(...classConditions));

  // Today's attendance %
  const today = new Date().toISOString().split("T")[0];
  const todayRecords = await db.select({ status: attendanceTable.status, count: sql<number>`count(*)` })
    .from(attendanceTable)
    .where(eq(attendanceTable.date, today as unknown as Date))
    .groupBy(attendanceTable.status);
  const totalToday = todayRecords.reduce((s, r) => s + Number(r.count), 0);
  const presentToday = todayRecords.find(r => r.status === "present");
  const attendancePct = totalToday > 0 ? (Number(presentToday?.count || 0) / totalToday) * 100 : 0;

  // Monthly fee stats
  const currentMonth = new Date().getMonth() + 1;
  const currentYear = new Date().getFullYear();
  const feeConditions = [eq(feesTable.month, currentMonth), eq(feesTable.year, currentYear)];
  if (schoolId) feeConditions.push(eq(feesTable.schoolId, schoolId));
  const fees = await db.select().from(feesTable).where(and(...feeConditions));
  const monthlyFeeCollection = fees.reduce((s, f) => s + parseFloat(f.paidAmount as string), 0);
  const pendingFees = fees.reduce((s, f) => s + (parseFloat(f.amount as string) - parseFloat(f.paidAmount as string)), 0);

  // Upcoming exams
  const examConditions = schoolId ? [eq(examsTable.schoolId, schoolId)] : [];
  const [examCount] = await db.select({ count: sql<number>`count(*)` })
    .from(examsTable).where(and(...examConditions));

  // Notifications
  const notifConditions = schoolId ? [eq(notificationsTable.schoolId, schoolId), eq(notificationsTable.isRead, false)] : [eq(notificationsTable.isRead, false)];
  const [notifCount] = await db.select({ count: sql<number>`count(*)` })
    .from(notificationsTable).where(and(...notifConditions));

  res.json({
    totalStudents: Number(studentCount.count),
    totalTeachers: Number(teacherCount.count),
    totalClasses: Number(classCount.count),
    todayAttendance: Math.round(attendancePct * 10) / 10,
    monthlyFeeCollection,
    pendingFees,
    upcomingExams: Number(examCount.count),
    recentNotifications: Number(notifCount.count),
  });
});

router.get("/attendance-chart", requireAuth, async (req, res) => {
  const month = req.query.month ? Number(req.query.month) : new Date().getMonth() + 1;
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();

  const data = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= Math.min(daysInMonth, 30); d++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const records = await db.select({ status: attendanceTable.status, count: sql<number>`count(*)` })
      .from(attendanceTable)
      .where(eq(attendanceTable.date, dateStr as unknown as Date))
      .groupBy(attendanceTable.status);
    const dayMap = Object.fromEntries(records.map(r => [r.status, Number(r.count)]));
    data.push({
      label: `${d}`,
      value: dayMap.present || 0,
      value2: dayMap.absent || 0,
      value3: dayMap.late || 0,
    });
  }

  res.json(data);
});

router.get("/fees-chart", requireAuth, async (req, res) => {
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
  const schoolId = req.user!.schoolId;

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const data = await Promise.all(months.map(async (label, idx) => {
    const m = idx + 1;
    const conditions = [eq(feesTable.month, m), eq(feesTable.year, year)];
    if (schoolId) conditions.push(eq(feesTable.schoolId, schoolId));
    const fees = await db.select().from(feesTable).where(and(...conditions));
    return {
      label,
      value: fees.reduce((s, f) => s + parseFloat(f.paidAmount as string), 0),
      value2: fees.reduce((s, f) => s + (parseFloat(f.amount as string) - parseFloat(f.paidAmount as string)), 0),
    };
  }));

  res.json(data);
});

export default router;
