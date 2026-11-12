/**
 * Authentication through the real web proxy (run through e2e/run.sh): the browser talks to the Next.js server,
 * whose /api rewrite forwards the browser's Origin unchanged to the API. Production-only details (Secure
 * __Host- cookie, both Cloud Run hostnames in APP_ORIGINS) are covered by apps/api/test/auth/auth.test.ts and
 * apps/api/test/deploy/web-origins.test.ts; this file proves the same rules hold end to end through the proxy.
 * Signs in once (administrator account) to stay well inside the login rate limit.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { API, BASE, EMAIL } from './support.ts';

const password = process.env.E2E_PASSWORD ?? '';
const json = { 'content-type': 'application/json' };
const credentials = JSON.stringify({ email: EMAIL.admin, password });
const code = async (res: Response) => ((await res.json()) as { code?: string }).code;

describe('authentication through the web proxy', () => {
  it('sign-in from another site is refused before credentials are checked', async () => {
    for (const origin of ['https://evil.example', `${BASE}.evil.example`, BASE.replace('http://', 'https://'), 'null']) {
      const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { ...json, origin }, body: credentials });
      assert.equal(res.status, 403, origin);
      assert.equal(await code(res), 'ORIGIN_NOT_ALLOWED', origin);
    }
    // A browser marks a cross-site request without Origin; that is refused too.
    const blind = await fetch(`${API}/auth/login`, { method: 'POST', headers: { ...json, 'sec-fetch-site': 'cross-site' }, body: credentials });
    assert.equal(blind.status, 403);
  });

  it('same-site sign-in sets an HttpOnly, SameSite=Lax session cookie; CSRF and Origin guard every change; sign-out ends the session', async () => {
    const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: { ...json, origin: BASE }, body: credentials });
    assert.equal(login.status, 200);
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const setCookie = login.headers.getSetCookie();
    assert.equal(setCookie.length, 1);
    assert.match(setCookie[0]!, /HttpOnly/i);
    assert.match(setCookie[0]!, /SameSite=Lax/i);
    assert.match(setCookie[0]!, /Path=\//i);
    const cookie = setCookie[0]!.split(';')[0]!;

    // Signed in; responses are never shared with other sites (no CORS grant).
    const me = await fetch(`${API}/me`, { headers: { cookie, origin: 'https://evil.example' } });
    assert.equal(me.status, 200);
    assert.equal(me.headers.get('access-control-allow-origin'), null);

    // State changes need the CSRF token, and are refused from another site even with it.
    const noToken = await fetch(`${API}/auth/logout`, { method: 'POST', headers: { cookie, origin: BASE } });
    assert.equal(noToken.status, 403);
    assert.equal(await code(noToken), 'CSRF_TOKEN_INVALID');
    const wrongToken = await fetch(`${API}/auth/logout`, { method: 'POST', headers: { cookie, origin: BASE, 'x-csrf-token': `${csrfToken}x` } });
    assert.equal(wrongToken.status, 403);
    const crossSite = await fetch(`${API}/auth/logout`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'x-csrf-token': csrfToken } });
    assert.equal(crossSite.status, 403);
    assert.equal(await code(crossSite), 'ORIGIN_NOT_ALLOWED');
    assert.equal((await fetch(`${API}/me`, { headers: { cookie } })).status, 200, 'refused attempts leave the session intact');

    // A real sign-out ends the session on the server, not just in the browser.
    const logout = await fetch(`${API}/auth/logout`, { method: 'POST', headers: { cookie, origin: BASE, 'x-csrf-token': csrfToken } });
    assert.ok(logout.status === 204 || logout.status === 200, `logout ${logout.status}`);
    assert.equal((await fetch(`${API}/me`, { headers: { cookie } })).status, 401);
  });

  it('protected pages and data require a session', async () => {
    assert.equal((await fetch(`${API}/me`)).status, 401);
    assert.equal((await fetch(`${API}/courses`)).status, 401);
    assert.equal((await fetch(`${API}/users`)).status, 401);
  });
});
