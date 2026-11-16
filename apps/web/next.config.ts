import type { NextConfig } from 'next';

/**
 * Same-origin API proxy. The browser only ever calls `/api/*` on the web origin; Next.js forwards
 * those requests to the Fastify API, so the HttpOnly session cookie stays first-party and the
 * API's Origin/CSRF checks see the real browser origin. API_ORIGIN is server-side configuration
 * (never exposed to the browser) and defaults to the local API.
 */
function apiOrigin(): string {
  const url = new URL(process.env.API_ORIGIN ?? 'http://127.0.0.1:4000');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('API_ORIGIN must be an http(s) URL');
  }
  return url.origin;
}

/** The API's fixed SCORM package inspection limit (AP-033B, apps/api/src/scorm/limits.ts). */
const SCORM_PACKAGE_MAX_MB = 25;

/**
 * Request bodies the proxy forwards in full. Next.js truncates larger bodies silently instead of
 * rejecting them, so this stays above the largest API upload limit — documents (DOCUMENT_MAX_UPLOAD_MB,
 * default 10) or SCORM packages (25 MB) — plus multipart overhead; the API then answers oversized
 * uploads with 413. 27 MB by default, below Cloud Run's 32 MiB HTTP/1 request limit.
 */
function proxyBodyLimitBytes(): number {
  const uploadMb = Number(process.env.DOCUMENT_MAX_UPLOAD_MB ?? 10);
  const documentMb = Number.isInteger(uploadMb) && uploadMb > 0 && uploadMb <= 100 ? uploadMb : 10;
  return (Math.max(documentMb, SCORM_PACKAGE_MAX_MB) + 2) * 1024 * 1024;
}

/**
 * Baseline browser protections for the web app's pages and assets: no MIME-type sniffing, only the origin
 * (never the full URL) as the referrer to other sites, and no framing by any site (clickjacking). The
 * Content-Security-Policy carries only `frame-ancestors`; it does not restrict scripts, styles or connections.
 */
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    proxyClientMaxBodySize: proxyBodyLimitBytes(),
  },
  async headers() {
    // Proxied API responses (/api/*) keep the headers the API sets, including the stricter
    // Content-Security-Policy on document downloads.
    return [{ source: '/((?!api/).*)', headers: SECURITY_HEADERS }];
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin()}/api/:path*` }];
  },
};

export default nextConfig;
