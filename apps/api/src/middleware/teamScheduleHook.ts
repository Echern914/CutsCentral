import type { NextFunction, Request, Response } from "express";
import { noteTeamScheduleChanged } from "../services/teamSchedule.js";

/**
 * On a route that changes a barber's HOURS or TIME OFF: after a successful
 * save, tell the teams they share their schedule with ("updated their
 * availability" in the owner's feed - never what changed).
 *
 * After the response, like the availability-cache hook on the same router:
 * it never delays the save, and a refused write (4xx/5xx) says nothing.
 * noteTeamScheduleChanged never throws.
 */
export function teamScheduleHook(req: Request, res: Response, next: NextFunction): void {
  const shopId = req.shop?.id;
  if (shopId) {
    res.on("finish", () => {
      if (res.statusCode < 400) void noteTeamScheduleChanged(shopId);
    });
  }
  next();
}
