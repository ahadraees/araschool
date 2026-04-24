import { Router } from "express";
import { db, timetableTable, classesTable, teachersTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

// GET /api/timetable?classId=&dayOfWeek=
router.get("/", requireAuth, async (req, res) => {
  try {
    const { user } = req as any;
    const classId   = req.query.classId   ? Number(req.query.classId)   : undefined;
    const dayOfWeek = req.query.dayOfWeek ? Number(req.query.dayOfWeek) : undefined;

    const conditions: any[] = [eq(timetableTable.schoolId, user.schoolId)];
    if (classId)   conditions.push(eq(timetableTable.classId, classId));
    if (dayOfWeek) conditions.push(eq(timetableTable.dayOfWeek, dayOfWeek));

    const rows = await db
      .select({
        id:         timetableTable.id,
        classId:    timetableTable.classId,
        teacherId:  timetableTable.teacherId,
        dayOfWeek:  timetableTable.dayOfWeek,
        periodNo:   timetableTable.periodNo,
        subject:    timetableTable.subject,
        startTime:  timetableTable.startTime,
        endTime:    timetableTable.endTime,
        room:       timetableTable.room,
        className:  classesTable.name,
        classSection: classesTable.section,
        teacherName: usersTable.name,
      })
      .from(timetableTable)
      .leftJoin(classesTable, eq(timetableTable.classId, classesTable.id))
      .leftJoin(teachersTable, eq(timetableTable.teacherId, teachersTable.id))
      .leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
      .where(and(...conditions))
      .orderBy(timetableTable.dayOfWeek, timetableTable.periodNo);

    res.json({ timetable: rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch timetable" });
  }
});

// POST /api/timetable — upsert a single period slot
router.post("/", requireAuth, async (req, res) => {
  try {
    const { user } = req as any;
    if (!["admin", "super_admin", "sub_admin"].includes(user.role)) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    const { classId, teacherId, dayOfWeek, periodNo, subject, startTime, endTime, room } = req.body;
    if (!classId || !dayOfWeek || !periodNo || !subject || !startTime || !endTime) {
      res.status(400).json({ error: "Missing required fields" }); return;
    }

    // Delete existing slot for same class+day+period then insert
    await db.delete(timetableTable).where(
      and(
        eq(timetableTable.schoolId, user.schoolId),
        eq(timetableTable.classId, classId),
        eq(timetableTable.dayOfWeek, dayOfWeek),
        eq(timetableTable.periodNo, periodNo),
      )
    );

    const [inserted] = await db.insert(timetableTable).values({
      schoolId: user.schoolId,
      classId,
      teacherId: teacherId || null,
      dayOfWeek,
      periodNo,
      subject,
      startTime,
      endTime,
      room: room || null,
    }).returning();

    res.status(201).json({ slot: inserted });
  } catch (err) {
    res.status(500).json({ error: "Failed to save timetable slot" });
  }
});

// POST /api/timetable/bulk — replace entire class timetable
router.post("/bulk", requireAuth, async (req, res) => {
  try {
    const { user } = req as any;
    if (!["admin", "super_admin", "sub_admin"].includes(user.role)) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    const { classId, slots } = req.body; // slots: array of {dayOfWeek,periodNo,subject,teacherId,startTime,endTime,room}
    if (!classId || !Array.isArray(slots)) {
      res.status(400).json({ error: "classId and slots[] required" }); return;
    }

    // Delete all existing for this class
    await db.delete(timetableTable).where(
      and(eq(timetableTable.schoolId, user.schoolId), eq(timetableTable.classId, classId))
    );

    if (slots.length > 0) {
      await db.insert(timetableTable).values(
        slots.map((s: any) => ({
          schoolId: user.schoolId,
          classId,
          teacherId: s.teacherId || null,
          dayOfWeek: s.dayOfWeek,
          periodNo: s.periodNo,
          subject: s.subject,
          startTime: s.startTime,
          endTime: s.endTime,
          room: s.room || null,
        }))
      );
    }

    res.json({ success: true, count: slots.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to save timetable" });
  }
});

// DELETE /api/timetable/:id
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const { user } = req as any;
    if (!["admin", "super_admin", "sub_admin"].includes(user.role)) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    await db.delete(timetableTable).where(
      and(eq(timetableTable.id, Number(req.params.id)), eq(timetableTable.schoolId, user.schoolId))
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete slot" });
  }
});

export default router;
