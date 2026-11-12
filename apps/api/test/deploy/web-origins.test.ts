/**
 * Deployment wiring for browser sign-in on Cloud Run: infra/web-origins.sh turns the web service's description into
 * the API's APP_ORIGINS (every URL the service reports, exact https://….run.app origins only), and deploy.yml passes
 * that list to the API intact. Skipped where bash or jq are not installed.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const SCRIPT = resolve(ROOT, 'infra/web-origins.sh');
const DETERMINISTIC = 'https://academiapath-web-871079669510.us-central1.run.app';
const DEFAULT_URL = 'https://academiapath-web-q2w3e4r5ta-uc.a.run.app';

const hasTools = (() => {
  try {
    execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const origins = (input: string, canonical = DETERMINISTIC) => {
  const run = spawnSync('bash', [SCRIPT, canonical], { input, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};
const service = (status?: string, annotated?: unknown) =>
  JSON.stringify({
    metadata: { annotations: annotated === undefined ? {} : { 'run.googleapis.com/urls': typeof annotated === 'string' ? annotated : JSON.stringify(annotated) } },
    status: status === undefined ? {} : { url: status },
  });

describe('web origins for the API (infra/web-origins.sh)', { skip: hasTools ? false : 'bash or jq not installed' }, () => {
  it('lists both Cloud Run URLs of the web service, the deterministic one first, without duplicates', () => {
    assert.equal(origins(service(DEFAULT_URL, [DETERMINISTIC, DEFAULT_URL])), `${DETERMINISTIC},${DEFAULT_URL}`);
    assert.equal(origins(service(DEFAULT_URL)), `${DETERMINISTIC},${DEFAULT_URL}`);
    assert.equal(origins(service(DETERMINISTIC, [DETERMINISTIC])), DETERMINISTIC);
  });

  it('falls back to the deterministic URL when the service is missing or cannot be described', () => {
    assert.equal(origins(''), DETERMINISTIC);
    assert.equal(origins('{}'), DETERMINISTIC);
    assert.equal(origins(service(undefined, 'not json')), DETERMINISTIC);
  });

  it('keeps only exact https://….run.app origins: no wildcards, other schemes, paths or other domains', () => {
    const hostile = ['*', 'https://*.run.app', 'http://academiapath-web-x-uc.a.run.app', 'https://evil.example', 'https://a.run.app.evil.example', 'https://x.run.app/path', 'https://x.run.app:8443', ' https://x.run.app'];
    assert.equal(origins(service('https://evil.example', hostile)), DETERMINISTIC);
  });

  it('produces a value the API accepts as APP_ORIGINS, unchanged', () => {
    const value = origins(service(DEFAULT_URL, [DETERMINISTIC, DEFAULT_URL]));
    const config = loadConfig({ NODE_ENV: 'production', APP_ORIGINS: value, DOCUMENT_STORAGE_DIR: '/var/lib/academiapath/documents' });
    assert.deepEqual(config.allowedOrigins, [DETERMINISTIC, DEFAULT_URL]);
  });
});

describe('deploy.yml passes every web origin to the API', () => {
  const workflow = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8');
  const apiDeploy = workflow.slice(workflow.indexOf('- name: Deploy API'), workflow.indexOf('- name: Deploy web'));

  it('derives APP_ORIGINS from the web service before the API is deployed', () => {
    const derive = workflow.indexOf('bash infra/web-origins.sh "$WEB_URL"');
    assert.ok(derive > 0, 'the workflow runs infra/web-origins.sh');
    assert.ok(derive < workflow.indexOf('- name: Deploy API'), 'before the API deploy');
    assert.match(workflow, /echo "APP_ORIGINS=\$\{APP_ORIGINS\}" >> "\$GITHUB_ENV"/);
  });

  it('sets the API variables with an @ delimiter, so the comma-separated origin list stays one value', () => {
    assert.match(apiDeploy, /--set-env-vars="\^@\^NODE_ENV=production@[^"]*@APP_ORIGINS=\$\{APP_ORIGINS\}@/);
    assert.doesNotMatch(apiDeploy, /APP_ORIGINS=\$\{WEB_URL\}/, 'not just the deterministic URL');
  });
});
