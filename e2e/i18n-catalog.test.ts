/**
 * Static localization guards (no browser or server needed):
 *   cd apps/api && node --import tsx --test ../../e2e/i18n-catalog.test.ts
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { defaultTermName, localizeTermName, MESSAGES } from '../apps/web/src/lib/i18n/messages.ts';
import { QUALITY_CODES } from '../apps/api/src/quality/rules.ts';

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

describe('content quality findings (AP-029)', () => {
  it('every quality code the API can report has an English and a Spanish description and correction guidance', () => {
    for (const locale of ['en', 'es'] as const) {
      const issues = MESSAGES[locale].quality.issues as Record<string, { title: (value: string) => string; fix: string }>;
      assert.deepEqual(Object.keys(issues).sort(), [...QUALITY_CODES].sort(), `${locale}: catalog codes match the API`);
      for (const code of QUALITY_CODES) {
        const issue = issues[code]!;
        assert.ok(issue.title('sample').trim().length > 10 && issue.fix.trim().length > 10, `${locale} ${code}`);
      }
    }
  });

  it('English and Spanish descriptions differ and authored values are shown unchanged', () => {
    for (const code of QUALITY_CODES) {
      assert.notEqual(MESSAGES.en.quality.issues[code].title('x'), MESSAGES.es.quality.issues[code].title('x'), code);
      assert.notEqual(MESSAGES.en.quality.issues[code].fix, MESSAGES.es.quality.issues[code].fix, code);
    }
    assert.match(MESSAGES.es.quality.issues.PLACEHOLDER_TEXT.title('TODO revisar'), /«TODO revisar»/);
    assert.match(MESSAGES.en.quality.issues.LINK_URL_INVALID.title('javascript:alert(1)'), /javascript:alert\(1\)$/);
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

/**
 * AP-042: the interface reads as an institutional LMS. No development or demonstration branding, while the honest
 * capability and security disclosures stay (rule-based tutor and extractive summaries without generative AI;
 * no malware scanning). Allowed exceptions, both accurate: the unlinked component showcase (/preview/courses, which
 * displays frontend sample data) and the activation-link panel that only renders with
 * ACCOUNT_INVITATION_DELIVERY=local_link, which production refuses.
 */
describe('production presentation (AP-042)', () => {
  const strings = (value: unknown, at = ''): Array<[string, string]> =>
    typeof value === 'string'
      ? [[at, value]]
      : value && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, child]) => strings(child, at ? `${at}.${key}` : key))
        : [];
  const BRANDING =
    /development preview|versi[oó]n de desarrollo|mock ai|ia simulada|local demonstration|demostraci[oó]n local|guided demo|demostraci[oó]n guiada|synthetic data only|solo datos sint[eé]ticos|not live ai|ia en vivo|demonstration data|datos de demostraci/i;
  const ALLOWED = new Set(['preview.badge', 'preview.noteTitle', 'users.linkTitle']);

  it('no development or demonstration branding in English or Spanish', () => {
    for (const locale of ['en', 'es'] as const) {
      const found = strings(MESSAGES[locale]).filter(([at, text]) => BRANDING.test(text) && !ALLOWED.has(at));
      assert.deepEqual(found, [], locale);
    }
  });

  it('no claim that content is produced by generative AI', () => {
    const CLAIM = /AI-generated|AI-powered|powered by AI|generated by AI|written by AI\b(?<!not written by AI)|generad[oa] por IA|impulsad[oa] por IA|con IA generativa/i;
    for (const locale of ['en', 'es'] as const) {
      assert.deepEqual(strings(MESSAGES[locale]).filter(([, text]) => CLAIM.test(text.replace(/not written by AI|no escrito por IA/gi, ''))), [], locale);
    }
  });

  it('capability and security disclosures are kept in both languages', () => {
    const { en, es } = MESSAGES;
    assert.match(en.tutor.badge, /rule-based, no generative AI/);
    assert.match(es.tutor.badge, /basado en reglas, sin IA generativa/);
    assert.match(en.documents.panel.mockLabel, /^Extractive summary — no generative AI$/);
    assert.match(es.documents.panel.mockLabel, /^Resumen extractivo — sin IA generativa$/);
    assert.match(en.documents.panel.explanation, /No AI model or external service is used/);
    assert.match(es.documents.panel.explanation, /No se usa ningún modelo de IA ni servicio externo/);
    assert.match(en.documents.brief.badge, /not written by AI/);
    assert.match(es.documents.brief.badge, /no escrito por IA/);
    assert.match(en.documents.library.notice, /not scanned for malware: no malware scanning service is connected\. Upload only documents from trusted sources\./);
    assert.match(es.documents.library.notice, /no se analizan en busca de malware: no hay un servicio de detección de malware conectado\. Sube solo documentos de fuentes de confianza\./);
    assert.match(en.documents.panel.notScanned, /malware/);
    assert.match(es.documents.panel.notScanned, /malware/);
    assert.equal(en.common.footer, 'AcademiaPath · Learning management system');
    assert.equal(es.common.footer, 'AcademiaPath · Sistema de gestión del aprendizaje');
  });
});
