/**
 * Interaction benchmark (run with `e2e/run.sh bench <label>`; writes e2e/results/bench-<label>.json).
 *
 * Every scenario runs E2E_BENCH_RUNS times (default 7) in a fresh, signed-in Chromium context with emulated network
 * latency (E2E_BENCH_LATENCY_MS per request, default 60 ms, roughly a browser → Cloud Run round trip), and records
 * the raw samples, median and p95 of:
 *   ms        click/navigation → page settled (level-1 heading shown, network idle, no loading state)
 *   feedbackMs  (navigations only) click → first visible response (loading state or new page)
 *   apiCalls  API requests made by the page
 *   apiMs     slowest API response seen by the browser (server + proxy time, excluding emulated latency)
 * Results are comparisons on one machine, not production figures: Cloud Run cold starts, the second Cloud Run hop
 * and the Cloud SQL tier are not reproduced locally.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { API, apiGet, BASE, context, EMAIL, launch, MESSAGES, settle, type Role } from './support.ts';

const RUNS = Number(process.env.E2E_BENCH_RUNS ?? 7);
const LATENCY = Number(process.env.E2E_BENCH_LATENCY_MS ?? 60);
const label = process.argv[2] ?? 'local';
const t = MESSAGES.en;

type Sample = { ms: number; feedbackMs?: number; apiCalls: number; apiMs: number };

async function emulate(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: LATENCY, downloadThroughput: -1, uploadThroughput: -1 });
}

function track(page: Page) {
  const calls: Array<{ start: number; end?: number }> = [];
  const byRequest = new Map<unknown, { start: number; end?: number }>();
  page.on('request', (request) => {
    if (!request.url().startsWith(API)) return;
    const entry = { start: Date.now() };
    calls.push(entry);
    byRequest.set(request, entry);
  });
  page.on('requestfinished', (request) => {
    const entry = byRequest.get(request);
    if (entry) entry.end = Date.now();
  });
  return {
    reset: () => calls.splice(0),
    result: () => ({ apiCalls: calls.length, apiMs: Math.max(0, ...calls.map((c) => (c.end ?? c.start) - c.start - LATENCY)) }),
  };
}

/** Full page load of `path` for `role`. */
function load(role: Role | null, pathname: string | (() => Promise<string>)) {
  return async (browser: Browser): Promise<Sample> => {
    const page = await (await context(browser, 'en', role ?? undefined)).newPage();
    await emulate(page);
    const tracker = track(page);
    const target = typeof pathname === 'string' ? pathname : await pathname();
    const start = Date.now();
    await page.goto(`${BASE}${target}`);
    await settle(page);
    const sample = { ms: Date.now() - start, ...tracker.result() };
    await page.context().close();
    return sample;
  };
}

/** Warm client-side navigation: from `from`, click the sidebar link `label`. */
function navigate(role: Role, from: string, linkLabel: string) {
  return async (browser: Browser): Promise<Sample> => {
    const page = await (await context(browser, 'en', role)).newPage();
    await page.goto(`${BASE}${from}`);
    await settle(page);
    await emulate(page);
    const tracker = track(page);
    tracker.reset();
    const link = page.locator('aside nav').getByRole('link', { name: linkLabel, exact: true });
    const href = (await link.getAttribute('href'))!;
    const start = Date.now();
    const feedback = page
      .waitForFunction((target) => location.pathname === target || !!document.querySelector('[data-route-loading],[data-nav-pending]'), href, { polling: 'raf' })
      .then(() => Date.now() - start);
    await link.click();
    await page.waitForURL((url) => url.pathname === href);
    await settle(page);
    const sample = { ms: Date.now() - start, feedbackMs: await feedback, ...tracker.result() };
    await page.context().close();
    return sample;
  };
}

/** Sign-in through the form until the dashboard has settled. */
async function signIn(browser: Browser): Promise<Sample> {
  const page = await (await context(browser, 'en')).newPage();
  await page.goto(`${BASE}/login`);
  await page.locator('#login-email').waitFor();
  await emulate(page);
  const tracker = track(page);
  await page.locator('#login-email').fill(EMAIL.student);
  await page.locator('#login-password').fill(process.env.E2E_PASSWORD!);
  const start = Date.now();
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/);
  await settle(page);
  const sample = { ms: Date.now() - start, ...tracker.result() };
  await page.context().close();
  return sample;
}

/** Sending one chat message through the API, as the message box does (server + proxy time). */
async function sendMessage(): Promise<Sample> {
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: EMAIL.instructor, password: process.env.E2E_PASSWORD }),
  });
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const conversations = (await (await fetch(`${API}/me/conversations?limit=50`, { headers: { cookie } })).json()) as { items: Array<{ id: string }> };
  const start = Date.now();
  const res = await fetch(`${API}/conversations/${conversations.items[0]!.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, cookie, 'x-csrf-token': csrfToken },
    body: JSON.stringify({ body: 'Benchmark message (synthetic).', clientMessageId: crypto.randomUUID() }),
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`send message: ${res.status}`);
  return { ms: Date.now() - start, apiCalls: 1, apiMs: Date.now() - start };
}

const firstCourse = (role: Role) => async () => (await apiGet<{ items: Array<{ id: string }> }>(role, '/courses')).items[0]!.id;

async function main() {
  const browser = await launch();
  const course = { student: await firstCourse('student')(), instructor: await firstCourse('instructor')() };
  const scenarios: Record<string, (browser: Browser) => Promise<Sample>> = {
    'sign-in → student dashboard': signIn,
    'load: student dashboard': load('student', '/dashboard'),
    'load: instructor dashboard': load('instructor', '/dashboard'),
    'load: teaching assistant dashboard': load('ta', '/dashboard'),
    'load: reviewer dashboard': load('reviewer', '/dashboard'),
    'load: admin overview': load('admin', '/admin'),
    'load: course list (student)': load('student', '/courses'),
    'load: course page (student)': load('student', `/courses/${course.student}`),
    'load: admin users': load('admin', '/admin/users'),
    'load: gradebook (instructor)': load('instructor', `/courses/${course.instructor}/grades`),
    'load: course forum (student)': load('student', `/courses/${course.student}/forum`),
    'load: my groups (student)': load('student', '/groups'),
    'load: login page (anonymous)': load(null, '/login'),
    'navigate: dashboard → my courses (student)': navigate('student', '/dashboard', t.nav.myCourses),
    'navigate: dashboard → calendar (student)': navigate('student', '/dashboard', t.nav.calendar),
    'navigate: admin overview → users': navigate('admin', '/admin', t.nav.users),
    'api: send a chat message (instructor)': sendMessage,
  };
  const stat = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
    return { median: at(0.5), p95: at(0.95) };
  };
  const results: Record<string, unknown> = {};
  for (const [name, run] of Object.entries(scenarios)) {
    await run(browser); // warm-up (compiles, caches), not recorded
    const samples: Sample[] = [];
    for (let i = 0; i < RUNS; i += 1) samples.push(await run(browser));
    const feedback = samples.flatMap((s) => (s.feedbackMs === undefined ? [] : [s.feedbackMs]));
    results[name] = {
      ms: stat(samples.map((s) => s.ms)),
      ...(feedback.length ? { feedbackMs: stat(feedback) } : {}),
      apiCalls: stat(samples.map((s) => s.apiCalls)),
      apiMs: stat(samples.map((s) => s.apiMs)),
      samples,
    };
    const r = results[name] as { ms: { median: number; p95: number }; apiCalls: { median: number } };
    console.log(`${name.padEnd(48)} median ${String(r.ms.median).padStart(5)} ms  p95 ${String(r.ms.p95).padStart(5)} ms  api calls ${r.apiCalls.median}`);
  }
  await browser.close();
  const out = path.join(import.meta.dirname, 'results', `bench-${label}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ label, runs: RUNS, latencyMs: LATENCY, recordedAt: new Date().toISOString(), results }, null, 1)}\n`);
  console.log(`written ${path.relative(process.cwd(), out)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
