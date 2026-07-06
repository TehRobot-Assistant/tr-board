import path from "node:path";

export const env = {
  port: Number(process.env.PORT ?? 8841),
  host: process.env.HOST ?? "0.0.0.0",
  /** absolute dir for attachment storage (docker volume in prod) */
  uploadsDir: path.resolve(
    process.env.UPLOADS_DIR ?? new URL("../../../data/uploads", import.meta.url).pathname,
  ),
  /** serve the built SPA from here in production */
  webDist: path.resolve(
    process.env.WEB_DIST ?? new URL("../../../web/dist", import.meta.url).pathname,
  ),
  prod: process.env.NODE_ENV === "production",
  /** open registration: first user is always allowed and becomes instance admin */
  allowRegistration: (process.env.ALLOW_REGISTRATION ?? "true") !== "false",
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
};
