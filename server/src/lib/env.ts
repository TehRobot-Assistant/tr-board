import path from "node:path";

/**
 * TRUST_PROXY (review M3) -> Fastify `trustProxy`. Unset/"false": trust no
 * proxy, so req.ip is the TCP peer and X-Forwarded-* are ignored. That is the
 * safe default for a container published straight on the LAN, but behind
 * NPM / a Cloudflare tunnel every request then looks like it came from the
 * proxy (one shared rate-limit bucket) and over plain http.
 *   "true"          trust every hop. Only when nothing can reach the app except
 *                   through the proxy: a client could otherwise forge XFF.
 *   "1", "2", ...   trust that many hops in front of the app.
 *   "a,b/cidr,..."  trust these proxy addresses (proxy-addr syntax, so the
 *                   names loopback / linklocal / uniquelocal work too).
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const v = raw?.trim() ?? "";
  if (!v || v === "false" || v === "0") return false;
  if (v === "true") return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * COOKIE_SECURE: "true" always marks the session cookie Secure, "false" never,
 * unset = Secure when the request arrived over https (which, with TRUST_PROXY,
 * includes X-Forwarded-Proto: https from the proxy). Set "true" when TLS ends
 * at Cloudflare and the hop to the app is plain http without a trustworthy
 * X-Forwarded-Proto (e.g. cloudflared -> NPM over http).
 */
function parseCookieSecure(raw: string | undefined): boolean | "auto" {
  const v = raw?.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return "auto";
}

const flag = (raw: string | undefined) => ["true", "1", "yes"].includes(raw?.trim().toLowerCase() ?? "");

/**
 * OIDC single sign-on (routes/oidc.ts). On when OIDC_ISSUER, OIDC_CLIENT_ID
 * and OIDC_REDIRECT_URI are all set; a half-configured block is reported at
 * boot and left off rather than failing every login.
 */
function oidcConfig() {
  const issuer = process.env.OIDC_ISSUER?.trim() ?? "";
  const clientId = process.env.OIDC_CLIENT_ID?.trim() ?? "";
  const redirectUri = process.env.OIDC_REDIRECT_URI?.trim() ?? "";
  const any = issuer || clientId || redirectUri;
  const enabled = !!(issuer && clientId && redirectUri);
  if (any && !enabled) {
    console.error("TR Board: OIDC is off: OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_REDIRECT_URI must all be set.");
  }
  const method = process.env.OIDC_TOKEN_AUTH_METHOD?.trim() || "client_secret_basic";
  return {
    enabled,
    issuer,
    clientId,
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
    redirectUri,
    scopes: process.env.OIDC_SCOPES?.trim() || "openid email profile",
    buttonLabel: process.env.OIDC_BUTTON_LABEL?.trim() || "Sign in with SSO",
    tokenAuthMethod: (method === "client_secret_post" ? "client_secret_post" : "client_secret_basic") as
      | "client_secret_basic"
      | "client_secret_post",
    /**
     * Create an account on first SSO login when no user has that (verified)
     * email. Off by default, and even when on it only applies while open
     * registration is allowed (ALLOW_REGISTRATION=true, or the very first
     * account): with registration closed, accounts still come only from an
     * admin, so SSO can't be used to get round invite-only.
     */
    autoProvision: flag(process.env.OIDC_AUTO_PROVISION),
    /** http:// issuers (tests, LAN-only IdPs). Never for anything internet-facing. */
    allowInsecure: flag(process.env.OIDC_ALLOW_INSECURE_HTTP),
  };
}

function backupConfig() {
  const dir = process.env.BACKUP_DIR?.trim() ? path.resolve(process.env.BACKUP_DIR.trim()) : "";
  const hours = Number(process.env.BACKUP_INTERVAL_HOURS ?? 24);
  return {
    /** scheduled backups are written here; unset = no scheduled backups */
    dir,
    intervalHours: Number.isFinite(hours) && hours > 0 ? hours : 0,
    keep: Math.max(1, Math.floor(Number(process.env.BACKUP_KEEP ?? 7)) || 7),
    /** largest archive accepted by the restore upload */
    maxRestoreBytes: Math.floor(Number(process.env.BACKUP_MAX_RESTORE_GB ?? 50) * 1024 ** 3),
  };
}

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
  /**
   * Open self-registration. OFF unless explicitly "true": the first account is
   * always allowed (and becomes instance admin); after that, accounts come from
   * an admin (/admin) and workspace invites. Defaulting to open meant whoever
   * reached a fresh instance first could sign up.
   */
  allowRegistration: process.env.ALLOW_REGISTRATION === "true",
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  cookieSecure: parseCookieSecure(process.env.COOKIE_SECURE),
  oidc: oidcConfig(),
  backup: backupConfig(),
};
