/**
 * Shared helpers for the browser regression suite (run through e2e/run.sh, which provides a disposable database,
 * the built API and web app, and the demo accounts' one-time password in E2E_PASSWORD).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { MESSAGES, type Locale } from '../apps/web/src/lib/i18n/messages.ts';

export const BASE = process.env.E2E_BASE ?? 'http://localhost:3000';
export const API = `${BASE}/api/v1`;
const PASSWORD = process.env.E2E_PASSWORD ?? '';

export type Role = 'admin' | 'instructor' | 'reviewer' | 'ta' | 'student';
export const EMAIL: Record<Role, string> = {
  admin: 'admin@academiapath.example',
  instructor: 'instructor@academiapath.example',
  reviewer: 'reviewer@academiapath.example',
  ta: 'ta@academiapath.example',
  student: 'student@academiapath.example',
};

/** Playwright from $PLAYWRIGHT_NODE_MODULES (see run.sh); it is deliberately not a workspace dependency. */
export function playwright(): typeof import('playwright') {
  const dir = process.env.PLAYWRIGHT_NODE_MODULES;
  if (!dir) throw new Error('PLAYWRIGHT_NODE_MODULES is not set; run the suite through e2e/run.sh');
  return createRequire(path.join(dir, 'noop.js'))('playwright');
}

export async function launch(): Promise<Browser> {
  if (!PASSWORD) throw new Error('E2E_PASSWORD is not set; run the suite through e2e/run.sh');
  return playwright().chromium.launch();
}

type SignedIn = { cookies: Array<{ name: string; value: string }>; csrfToken: string };
const sessions = new Map<Role, Promise<SignedIn>>();
/** A demo account's session (signed in once per test file through the API, as the browser would). */
export function session(role: Role): Promise<SignedIn> {
  if (!sessions.has(role)) {
    sessions.set(
      role,
      fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ email: EMAIL[role], password: PASSWORD }),
      }).then(async (res) => {
        if (res.status !== 200) throw new Error(`sign-in for ${role} failed with ${res.status}`);
        const { csrfToken } = (await res.json()) as { csrfToken: string };
        const cookies = res.headers.getSetCookie().map((cookie) => {
          const pair = cookie.split(';')[0]!;
          const index = pair.indexOf('=');
          return { name: pair.slice(0, index), value: pair.slice(index + 1) };
        });
        return { cookies, csrfToken };
      }),
    );
  }
  return sessions.get(role)!;
}

/** Session cookies for a demo account. */
export const sessionCookies = async (role: Role) => (await session(role)).cookies;

/** A state-changing API request as `role` (same-site Origin and CSRF token, like the web app). */
export async function apiWrite<T>(role: Role, method: 'POST' | 'PUT' | 'DELETE', pathname: string, body?: unknown): Promise<T> {
  const { cookies, csrfToken } = await session(role);
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '), origin: BASE, 'x-csrf-token': csrfToken, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${pathname} as ${role}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

/** A browser context in the given interface language, signed in as `role` (or anonymous). */
export async function context(browser: Browser, locale: Locale, role?: Role, options: { width?: number } = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 } });
  const cookies = [{ name: 'ap_locale', value: locale }, ...(role ? await sessionCookies(role) : [])];
  await ctx.addCookies(cookies.map((cookie) => ({ ...cookie, url: BASE })));
  return ctx;
}

/** JSON from the API with a role's session (read-only helper used to find ids for detail pages). */
export async function apiGet<T>(role: Role, pathname: string): Promise<T> {
  const cookie = (await sessionCookies(role)).map((c) => `${c.name}=${c.value}`).join('; ');
  const res = await fetch(`${API}${pathname}`, { headers: { cookie } });
  if (!res.ok) throw new Error(`GET ${pathname} as ${role}: ${res.status}`);
  return (await res.json()) as T;
}

/** Waits until the page's requests have finished and its level-1 heading is shown. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 15_000 });
}

// ------------------------------------------------------------------------------------------- catalog leak scanner

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => strings(item, out));
  return out;
}

/**
 * Interface phrases of the OTHER language that must never be shown: every catalog string of `other` that is a
 * real phrase (two or more words, at least 12 characters, no template placeholders) and does not also exist in
 * the page's own catalog. Authored content is never in the catalogs, so it is never flagged.
 */
export function foreignPhrases(locale: Locale): string[] {
  const other: Locale = locale === 'en' ? 'es' : 'en';
  const own = new Set(strings(MESSAGES[locale]));
  return [...new Set(strings(MESSAGES[other]))].filter(
    (text) => !own.has(text) && text.length >= 12 && /\S\s+\S/.test(text) && !/[{}$]/.test(text),
  );
}

/** Visible text plus accessible names, titles and placeholders of the page. */
export async function interfaceText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const attributes = [...document.querySelectorAll('[aria-label],[title],[placeholder],[alt],[aria-valuetext]')].flatMap((el) =>
      ['aria-label', 'title', 'placeholder', 'alt', 'aria-valuetext'].map((name) => el.getAttribute(name) ?? ''),
    );
    return [document.title, document.body.innerText, ...attributes].join('\n');
  });
}

export async function leaks(page: Page, locale: Locale): Promise<string[]> {
  const text = await interfaceText(page);
  return foreignPhrases(locale).filter((phrase) => text.includes(phrase));
}

export { MESSAGES };
export type { Locale };
