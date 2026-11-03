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

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin()}/api/:path*` }];
  },
};

export default nextConfig;
