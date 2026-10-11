import type { NextConfig } from "next";

/**
 * Game frame isolation (src/app/game-frame): the platform embeds it with
 * sandbox="allow-scripts" (opaque origin). This CSP is the second, independent layer:
 * no network access at all (connect-src 'none'), no forms, no plugins, no base-uri tricks,
 * and only this site may embed it. 'unsafe-inline' is required by Next.js' inline bootstrap
 * scripts; with no network and no platform origin, inline script cannot exfiltrate anything.
 * Development adds what the dev server needs (eval + HMR websocket).
 */
const isDev = process.env.NODE_ENV !== "production";
const GAME_FRAME_CSP = [
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

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
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
