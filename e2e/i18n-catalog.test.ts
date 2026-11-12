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
    return statSync(full).isDirectory() ? files(full) : /\.tsx?$/.test(full) ? [full] : [];
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

/**
 * Interface text written directly in components instead of the catalog cannot be caught by the browser leak scan
 * (it only knows catalog phrases), so the sources are scanned for the patterns that let English through before:
 * JSX text of two or more words, literal interface attributes (aria-label, placeholder, title, alt, label…),
 * template-literal labels with English words, and English default values for label props.
 */
const HARDCODED_ALLOWED = new Set([
  // Language-neutral examples (a program code and a product name) shown as input placeholders.
  'components/admin/academics/AcademicPanels.tsx IT-MGMT',
  'components/admin/academics/AcademicPanels.tsx ITIL Foundation',
  // Fallback defaults of shared components; every caller passes the localized text (checked when this was added).
  'components/courses/CourseCard.tsx Status',
  'components/ui/PageHeader.tsx Breadcrumb',
]);

function hardcodedText(webSrc: string): string[] {
  const words = (text: string) => (text.match(/[A-Za-zÁÉÍÓÚáéíóúñÑ]{2,}/g) ?? []).length;
  const code = (text: string) => /\b\w+\.\w+/.test(text) || /\s[?:]\s/.test(text);
  const found: string[] = [];
  const tsx = [...files(path.join(webSrc, 'app')), ...files(path.join(webSrc, 'components'))].filter((file) => file.endsWith('.tsx'));
  for (const file of tsx) {
    const rel = path.relative(webSrc, file);
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const text = line.trim();
        if (/^(\/\/|\*|\/\*|\{\/\*)/.test(text)) return;
        const hit = (literal: string) => {
          if (!HARDCODED_ALLOWED.has(`${rel} ${literal}`)) found.push(`${rel}:${index + 1} "${literal}"`);
        };
        if (/^[A-Z][a-zA-Z'’]*(\s+[a-zA-Z'’,()-]+)+[.:!?…]?$/.test(text) && !/[=;{}<>]/.test(text)) hit(text);
        for (const m of line.matchAll(/(?<=[\w"'}])>([^<>{}=;()`]*?[A-Za-z][^<>{}=;()`]*?)(?=<|\{)/g)) if (words(m[1]!) >= 2 && !code(m[1]!)) hit(m[1]!.trim());
        for (const m of line.matchAll(/\b(?:aria-label|aria-valuetext|placeholder|title|alt|label|description|emptyTitle|emptyDescription|accessibleLabel|statusLabel)=["']([^"']+)["']/g)) if (words(m[1]!) >= 2) hit(m[1]!);
        for (const m of line.matchAll(/\b(?:aria-label|aria-valuetext|placeholder|title|alt|label|accessibleLabel)=\{`([^`]*)`\}/g)) {
          const literal = m[1]!.replace(/\$\{[^}]*\}/g, ' ');
          if (/[A-Za-z]{3,}/.test(literal)) hit(m[1]!);
        }
        for (const m of line.matchAll(/\b(?:label|title|description|emptyTitle|emptyDescription|statusLabel|accessibleLabel)\s*=\s*'([^']+)'/g)) if (words(m[1]!) >= 1) hit(m[1]!);
      });
  }
  return found;
}

describe('interface text in components', () => {
  it('no interface text is hardcoded outside the catalogs', () => {
    assert.deepEqual(hardcodedText(path.join(ROOT, 'apps/web/src')), [], 'move these texts to apps/web/src/lib/i18n (EN and ES)');
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
