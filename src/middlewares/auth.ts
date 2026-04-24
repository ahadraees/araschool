import type { Request, Response, NextFunction } from "express";
import { getUserFromToken } from "../lib/auth.js";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: number;
        email: string;
        name: string;
        role: string;
        schoolId: number | null;
        isActive: boolean;
        permissions: string[];
      };
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.["sms_session"] || req.headers["authorization"]?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
    return;
  }

  const user = await getUserFromToken(token);
  if (!user || !user.isActive) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid or expired session" });
    return;
  }

  let perms: string[] = [];
  try { perms = JSON.parse(user.permissions || "[]"); } catch { perms = []; }

  req.user = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    schoolId: user.schoolId,
    isActive: user.isActive,
    permissions: perms,
  };
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Forbidden", message: "Insufficient permissions" });
      return;
    }
    next();
  };
}
