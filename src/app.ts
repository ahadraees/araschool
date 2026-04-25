import express, { type Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import cron from "node-cron";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { runAutoAbsent, runAutoAbsentStaff } from "./routes/attendance.js";

const app: Express = express();

// ── Trust proxy (Replit/Render/etc. put a reverse proxy in front) ─────────────
app.set("trust proxy", 1);

// ── Gzip compression for all responses ───────────────────────────────────────
app.use(compression({ level: 6, threshold: 1024 }));

// ── Security headers via Helmet ───────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false,   // CSP is handled by the frontend Vite config
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
  }),
);

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Auth endpoints: strict limit to prevent brute-force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 30,                     // 30 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests", message: "Please try again after 15 minutes" },
  skip: (req) => req.method === "OPTIONS",
});

// General API: generous limit
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,         // 1 minute
  max: 300,                    // 300 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests", message: "Please slow down" },
  skip: (req) => req.method === "OPTIONS",
});

app.use("/api/auth", authLimiter);
app.use("/api", apiLimiter);

// ── CORS — allow Replit, localhost, and any custom FRONTEND_URL env var ────────
// Set FRONTEND_URL=https://yourdomain.com when self-hosting
const extraOrigins = (process.env.FRONTEND_URL ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const defaultOrigins = ["https://aranext.pakbooyah.com"];
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);                                // same-origin / server-to-server
      if (/replit\.dev$|localhost(:\d+)?$/.test(origin)) return cb(null, true);
      if ([...defaultOrigins, ...extraOrigins].includes(origin)) return cb(null, true);
      cb(new Error("CORS: origin not allowed"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  }),
);

// ── Request logging ───────────────────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) { return { id: req.id, method: req.method, url: req.url?.split("?")[0] }; },
      res(res) { return { statusCode: res.statusCode }; },
    },
  }),
);

// ── Body parsing — strict size limits ────────────────────────────────────────
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use(cookieParser());

// ── Remove X-Powered-By ──────────────────────────────────────────────────────
app.disable("x-powered-by");

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api", router);

// ── Global error handler (hide stack traces in production) ────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Unhandled error");
  const isDev = process.env.NODE_ENV !== "production";
  res.status(500).json({
    error: "Internal Server Error",
    ...(isDev ? { message: err.message } : {}),
  });
});

// ── Auto-absent cron: every day at 9:30 AM (PKT) ─────────────────────────────
cron.schedule("30 9 * * 1-6", async () => {
  logger.info("Auto-absent cron running at 9:30 AM");
  try {
    const [studentResult, staffResult] = await Promise.all([
      runAutoAbsent(),
      runAutoAbsentStaff(),
    ]);
    logger.info({ studentResult, staffResult }, "Auto-absent cron completed");
  } catch (err) {
    logger.error({ err }, "Auto-absent cron failed");
  }
}, { timezone: "Asia/Karachi" });

export default app;
