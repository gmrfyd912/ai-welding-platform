import { createServer } from "http";
import type { Express } from "express";
import { registerWeldAnalysisRoute } from "./weld-analysis";
import { registerAuthRoutes } from "./auth-routes";
import { registerResultsRoutes } from "./results-routes";
import { registerTheoryRoutes } from "./theory-routes";
import { registerOxRoutes } from "./ox-routes";
import { registerCoachingRoutes } from "./coaching-routes";

export async function registerRoutes(app: Express) {
  registerAuthRoutes(app);
  registerResultsRoutes(app);
  registerTheoryRoutes(app);
  registerOxRoutes(app);
  registerCoachingRoutes(app);
  registerWeldAnalysisRoute(app);
  return createServer(app);
}
