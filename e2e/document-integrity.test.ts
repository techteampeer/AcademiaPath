/**
 * AP-040B document integrity in the browser (run through e2e/run.sh against the production build, with the disposable
 * storage directory and database the script creates; never the cloud bucket). Synthetic documents are uploaded through
 * the API as the instructor, then one stored file is removed and one altered on the local disk. The download link
 * explains a missing or corrupt file in the interface language and saves nothing; a valid file still downloads intact.
 */
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { makePdf } from '../apps/api/test/helpers/documents.ts';
import { API, apiGet, BASE, context, launch, MESSAGES, session, settle, type Locale, type Role } from './support.ts';

let browser: Browser;
let courseId: string;
const docs = {} as Record<'valid' | 'missing' | 'corrupt', string>;
const validPdf = makePdf([['Valid handout', 'This synthetic handout is stored and verified correctly.']]);

async function storageKey(activityId: string): Promise<string> {
  const pg = ((await import(process.env.PG_MODULE!)) as { default: typeof import('pg') }).default;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<{ storage_key: string }>('SELECT storage_key FROM course_documents WHERE activity_id = $1', [activityId])).rows[0]!.storage_key;
  } finally {
    await client.end();
  }
}
/** The disposable local storage directory e2e/run.sh created for this run. */
const storedFile = async (activityId: string) => join(process.env.DOCUMENT_STORAGE_DIR!, await storageKey(activityId));

async function upload(section: string, fileName: string, data: Buffer, title: string): Promise<string> {
  const { cookies, csrfToken } = await session('instructor');
  const form = new FormData();
  form.append('title', title);
  form.append('file', new Blob([new Uint8Array(data)]), fileName);
  const res = await fetch(`${API}/courses/${courseId}/sections/${section}/documents`, {
    method: 'POST',
    headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '), origin: BASE, 'x-csrf-token': csrfToken },
    body: form,
  });
  if (res.status !== 201) throw new Error(`upload ${fileName}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { activityId: string }).activityId;
}

async function open(role: Role, activityId: string, locale: Locale): Promise<Page> {
  const page = await (await context(browser, locale, role)).newPage();
  await page.goto(`${BASE}/courses/${courseId}/activities/${activityId}`);
  await settle(page);
  return page;
}

before(async () => {
  assert.ok(process.env.DOCUMENT_STORAGE_DIR && process.env.DATABASE_URL && process.env.PG_MODULE, 'run through e2e/run.sh');
  browser = await launch();
  courseId = (await apiGet<{ items: Array<{ id: string; code: string }> }>('instructor', '/courses?limit=100')).items.find((c) => c.code === 'ITIL4-F-2026-2-A')!.id;
  const section = (await apiGet<{ items: Array<{ id: string }> }>('instructor', `/courses/${courseId}/sections?limit=100`)).items[0]!.id;
  docs.valid = await upload(section, 'valid-handout.pdf', validPdf, 'Integrity check: valid (draft)');
  docs.missing = await upload(section, 'missing-handout.pdf', makePdf([['Missing handout', 'Its stored file is removed by this test.']]), 'Integrity check: missing (draft)');
  docs.corrupt = await upload(section, 'corrupt-handout.pdf', makePdf([['Corrupt handout', 'Its stored file is altered by this test.']]), 'Integrity check: corrupt (draft)');
  await rm(await storedFile(docs.missing));
  const corruptPath = await storedFile(docs.corrupt);
  const bytes = await readFile(corruptPath);
  bytes[bytes.length - 20] = bytes[bytes.length - 20]! ^ 0xff;
  await writeFile(corruptPath, bytes);
});

after(async () => {
  await browser?.close();
});

describe('document download integrity (browser)', () => {
  for (const [kind, code] of [
    ['missing', 'DOCUMENT_FILE_MISSING'],
    ['corrupt', 'DOCUMENT_FILE_CORRUPT'],
  ] as const) {
    it(`a ${kind} stored file is explained in English and Spanish, and nothing is saved`, async () => {
      for (const locale of ['en', 'es'] as const) {
        const page = await open('instructor', docs[kind], locale);
        let downloads = 0;
        page.on('download', () => void (downloads += 1));
        await page.getByRole('link', { name: MESSAGES[locale].documents.panel.download }).click();
        const alert = page.locator('[data-download-error]');
        await alert.waitFor();
        assert.equal(await alert.innerText(), MESSAGES[locale].errors.codes[code]);
        assert.equal(await alert.getAttribute('role'), 'alert', 'announced to screen readers');
        assert.equal(downloads, 0, 'no error response is saved as the document');
        const text = await page.locator('main').innerText();
        assert.ok(!text.includes(process.env.DOCUMENT_STORAGE_DIR!) && !text.includes(await storageKey(docs[kind])), 'no storage path or key is shown');
        await page.context().close();
      }
    });
  }

  it('a valid file still downloads with its original name and exact bytes', async () => {
    const page = await open('instructor', docs.valid, 'en');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: MESSAGES.en.documents.panel.download }).click()]);
    assert.equal(download.suggestedFilename(), 'valid-handout.pdf');
    assert.ok(validPdf.equals(await readFile((await download.path())!)), 'the downloaded bytes are the uploaded file');
    assert.equal(await page.locator('[data-download-error]').count(), 0);
    await page.context().close();
  });
});
