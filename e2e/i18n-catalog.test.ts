/**
 * Static localization guards (no browser or server needed):
 *   cd apps/api && node --import tsx --test ../../e2e/i18n-catalog.test.ts
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { defaultTermName, localizeTermName, MESSAGES } from '../apps/web/src/lib/i18n/messages.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

function shape(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) => shape(child, prefix ? `${prefix}.${key}` : key));
  }
  return [`${prefix}:${Array.isArray(value) ? `array(${value.length})` : typeof value}`];
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('interface catalogs', () => {
  it('English and Spanish have exactly the same keys, value kinds and list lengths', () => {
    assert.deepEqual(shape(MESSAGES.es).sort(), shape(MESSAGES.en).sort());
  });

  it('no English phrase was left untranslated in the Spanish catalog', () => {
    const allowed = new Set(['Word (.docx)', 'PowerPoint (.pptx)']);
    const same: string[] = [];
    const walk = (en: unknown, es: unknown, at: string) => {
      if (typeof en === 'string') {
        if (en === es && en.length >= 12 && /\S\s+\S/.test(en) && !allowed.has(en)) same.push(`${at}: ${en}`);
      } else if (en && typeof en === 'object') {
        for (const key of Object.keys(en)) walk((en as Record<string, unknown>)[key], (es as Record<string, unknown>)?.[key], `${at}.${key}`);
      }
    };
    walk(MESSAGES.en, MESSAGES.es, 'messages');
    assert.deepEqual(same, []);
  });

  it('every problem code the API can return has an English and a Spanish description', () => {
    const codes = new Set<string>();
    for (const file of files(path.join(ROOT, 'apps/api/src'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:new ApiProblem\(\s*\d+,\s*|sendError\(reply,\s*\d+,\s*)'([A-Z][A-Z0-9_]+)'/g)) codes.add(match[1]!);
    }
    assert.ok(codes.size > 50, `found only ${codes.size} codes; the extraction pattern no longer matches the API`);
    const missing = [...codes].filter((code) => !MESSAGES.es.errors.codes[code] || !MESSAGES.en.errors.codes[code]).sort();
    assert.deepEqual(missing, [], 'add these codes to apps/web/src/lib/i18n/catalog/errors.ts (EN and ES)');
  });
});

describe('academic term names', () => {
  it('standard generated names follow the interface language', () => {
    assert.equal(localizeTermName('Semestre 2026-2', 'en'), 'Semester 2026-2');
    assert.equal(localizeTermName('Semester 2026-2', 'es'), 'Semestre 2026-2');
    assert.equal(localizeTermName('Semestre 2026-2', 'es'), 'Semestre 2026-2');
    assert.equal(localizeTermName('Verano 2027-0', 'en'), 'Summer term 2027-0');
    assert.equal(localizeTermName('Summer term 2027-0', 'es'), 'Verano 2027-0');
    assert.equal(localizeTermName('semestre 2026-1', 'en'), 'Semester 2026-1');
    // Certificate periods add the academic year.
    assert.equal(localizeTermName('Semestre 2026-2 (2026)', 'en'), 'Semester 2026-2 (2026)');
  });

  it('names an administrator wrote differently are shown exactly as entered', () => {
    for (const name of ['Ciclo de verano intensivo', 'Semestre académico 2026-II', 'Term A', 'Semestre 2026-2 — Lima', '']) {
      assert.equal(localizeTermName(name, 'en'), name);
      assert.equal(localizeTermName(name, 'es'), name);
    }
  });

  it('the stored default stays the institution’s canonical form whatever the interface language', () => {
    assert.equal(defaultTermName('2026-2', '2'), 'Semestre 2026-2');
    assert.equal(defaultTermName('2027-0', '0'), 'Verano 2027-0');
    assert.equal(localizeTermName(defaultTermName('2027-0', '0'), 'en'), 'Summer term 2027-0');
  });
});
