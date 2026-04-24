import type { Request, Response, NextFunction, RequestHandler } from "express";
import { logger } from "./logger.js";

type AsyncFn = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Wraps an async Express route handler to catch any thrown errors
 * and forward them to Express's error handler (instead of crashing).
 */
export function asyncHandler(fn: AsyncFn): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((err: unknown) => {
      logger.error({ err, url: req.url, method: req.method }, "Route handler error");
      next(err);
    });
  };
}
