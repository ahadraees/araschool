import { Router } from "express";
import { db, smsSettingsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

// GET /api/sms-settings
router.get("/", requireAuth, async (req, res) => {
  try {
    const { user } = req as any;
    if (!["admin", "super_admin", "sub_admin"].includes(user.role)) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    const settings = await db.query.smsSettingsTable.findFirst({
      where: eq(smsSettingsTable.schoolId, user.schoolId),
    });
    // Never expose auth token in full — mask it
    if (settings?.authToken) {
      (settings as any).authToken = "••••••••" + settings.authToken.slice(-4);
    }
    res.json({ settings: settings ?? null });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch SMS settings" });
  }
});

// POST /api/sms-settings — create or update
router.post("/", requireAuth, async (req, res) => {
  try {
    const { user } = req as any;
    if (!["admin", "super_admin"].includes(user.role)) {
      res.status(403).json({ error: "Forbidden" }); return;
    }

    const {
      provider, accountSid, authToken, fromNumber,
      whatsappEnabled, smsEnabled,
      notifyAbsent, notifyFeesDue, notifyMarks, notifyExam,
    } = req.body;

    const existing = await db.query.smsSettingsTable.findFirst({
      where: eq(smsSettingsTable.schoolId, user.schoolId),
    });

    const updateData: any = {
      provider: provider ?? "twilio",
      fromNumber, whatsappEnabled, smsEnabled,
      notifyAbsent, notifyFeesDue, notifyMarks, notifyExam,
      updatedAt: new Date(),
    };
    // Only update authToken if it's not masked (i.e., user changed it)
    if (authToken && !authToken.startsWith("••••")) updateData.authToken = authToken;
    if (accountSid) updateData.accountSid = accountSid;

    if (existing) {
      const [updated] = await db.update(smsSettingsTable)
        .set(updateData)
        .where(eq(smsSettingsTable.schoolId, user.schoolId))
        .returning();
      res.json({ settings: updated });
    } else {
      const [inserted] = await db.insert(smsSettingsTable)
        .values({ schoolId: user.schoolId, ...updateData })
        .returning();
      res.json({ settings: inserted });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to save SMS settings" });
  }
});

// POST /api/sms-settings/test — send a test SMS
router.post("/test", requireAuth, async (req, res) => {
  try {
    const { user } = req as any;
    if (!["admin", "super_admin"].includes(user.role)) {
      res.status(403).json({ error: "Forbidden" }); return;
    }

    const settings = await db.query.smsSettingsTable.findFirst({
      where: eq(smsSettingsTable.schoolId, user.schoolId),
    });

    if (!settings?.accountSid || !settings?.authToken || !settings?.fromNumber) {
      res.status(400).json({ error: "SMS credentials not configured" }); return;
    }

    const { to } = req.body;
    if (!to) { res.status(400).json({ error: "Phone number required" }); return; }

    const message = await sendSmsOrWhatsapp(settings, to, "✅ Test message from AraSchool — your SMS notifications are working!");
    res.json({ success: true, sid: message });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to send test SMS" });
  }
});

// ── Internal helper: send SMS/WhatsApp via Twilio ─────────────────────────────
export async function sendSmsOrWhatsapp(
  settings: { accountSid?: string | null; authToken?: string | null; fromNumber?: string | null; whatsappEnabled?: boolean; smsEnabled?: boolean },
  to: string,
  body: string,
): Promise<string | null> {
  if (!settings.accountSid || !settings.authToken || !settings.fromNumber) return null;
  if (!settings.smsEnabled && !settings.whatsappEnabled) return null;

  try {
    const twilio = await import("twilio");
    const client = twilio.default(settings.accountSid, settings.authToken);

    const from = settings.whatsappEnabled
      ? (settings.fromNumber.startsWith("whatsapp:") ? settings.fromNumber : `whatsapp:${settings.fromNumber}`)
      : settings.fromNumber;

    const toFormatted = settings.whatsappEnabled
      ? (to.startsWith("whatsapp:") ? to : `whatsapp:${to}`)
      : to;

    const msg = await client.messages.create({ from, to: toFormatted, body });
    return msg.sid;
  } catch (err: any) {
    console.error("[SMS]", err.message);
    return null;
  }
}

export default router;
