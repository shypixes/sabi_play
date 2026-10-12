import type { NextConfig } from "next";

/**
 * Game frame isolation (src/app/game-frame). Two independent sandboxes apply:
 * - the platform's iframe attribute sandbox="allow-scripts" (GameHost), and
 * - the CSP `sandbox allow-scripts` directive below, which the browser applies to the response
 *   itself. It also covers the frame URL opened directly (top level), where no iframe attribute
 *   exists: the document still gets an opaque origin, so it can never read the platform's
 *   cookies or storage or act as the platform origin.
 * The rest of the CSP: no network access (connect-src 'none'), no forms, plugins, workers or
 * sub-frames, no base-uri tricks, and only this site may embed it. 'unsafe-inline' is required by
 * Next.js' inline bootstrap scripts; the document has no platform origin and no network access.
 * Note: CSP cannot stop the frame navigating itself; the host detects that (GameHost/controller).
 * Development adds what the dev server needs (eval + HMR websocket).
 */
const isDev = process.env.NODE_ENV !== "production";
const GAME_FRAME_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src ${isDev ? "'self' ws: wss:" : "'none'"}`,
  "frame-ancestors 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
].join("; ");

/** Header source for all routes except /game-frame and anything below it. */
const APP_ROUTES = "/:path((?!game-frame(?:/|$)).*)";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Every platform route except the game frame: only this site may embed it (clickjacking
        // defence). No platform page is meant to be embedded; the game frame has its own policy.
        source: APP_ROUTES,
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
      {
        source: "/game-frame/:path*",
        headers: [
          { key: "Content-Security-Policy", value: GAME_FRAME_CSP },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), clipboard-read=(), display-capture=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
