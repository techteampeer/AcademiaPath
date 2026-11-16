/**
 * AP-033B offline SCORM package inspection: the same read-only validation as
 * POST /api/v1/courses/{id}/scorm-inspections, run locally on a file.
 *
 *   pnpm scorm:inspect <package.zip>          concise summary
 *   pnpm scorm:inspect --json <package.zip>   machine-readable report
 *
 * It only reads the given file. It never executes, modifies, extracts or uploads the package, never fetches anything
 * a package refers to, and never connects to a database or any service (there is nothing to configure).
 *
 * Exit codes: 0 the package is structurally valid (warnings allowed), 1 the package is invalid, 2 the command could
 * not run (usage error, unreadable file).
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { displayFileName, oversizeReport } from '../src/scorm/inspect.js';
import { inspectInWorker } from '../src/scorm/inspection.js';
import { SCORM_LIMITS } from '../src/scorm/limits.js';
import type { ScormInspectionReport } from '../src/scorm/report.js';

export const INSPECT_EXIT = { valid: 0, invalid: 1, usage: 2 } as const;

const USAGE = 'Usage: pnpm scorm:inspect [--json] <package.zip>';
const size = (bytes: number) => (bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);
const VERSION_LABEL = { scorm_1_2: 'SCORM 1.2', scorm_2004: 'SCORM 2004' } as const;
const SUPPORT_LABEL = {
  planned: 'planned for a later milestone',
  planned_without_sequencing: 'planned for a later milestone, without SCORM 2004 sequencing',
  not_supported: 'not possible for this package as inspected',
} as const;

export function summary(report: ScormInspectionReport): string {
  const errors = report.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = report.issues.length - errors;
  const standard =
    report.standard.version !== null
      ? `${VERSION_LABEL[report.standard.version]}${report.standard.edition ? ` (${report.standard.edition} Edition)` : ''}`
      : report.standard.format === 'common_cartridge'
        ? 'IMS Common Cartridge (not SCORM)'
        : 'not identified';
  const lines = [
    'SCORM package inspection (read-only: nothing was imported, uploaded, extracted or executed)',
    `File:      ${report.package.fileName ?? '(unnamed)'} — ${size(report.package.compressedBytes)} compressed${report.package.uncompressedBytes === null ? '' : `, ${size(report.package.uncompressedBytes)} uncompressed`}, ${report.package.fileCount} files`,
    `SHA-256:   ${report.package.sha256}`,
    `Standard:  ${standard}${report.standard.schemaVersion ? ` — declared "${report.standard.schemaVersion}"` : ''}`,
    `Title:     ${report.title ?? '(none)'}`,
    `Result:    ${report.status.replaceAll('_', ' ').toUpperCase()} — ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}${report.issuesTruncated ? ' (list truncated)' : ''}`,
    `Structure: ${report.counts.organizations} organization(s), ${report.counts.items} item(s), ${report.counts.resources} resource(s): ${report.counts.scos} SCO(s), ${report.counts.assets} asset(s); ${report.counts.launchable} launchable`,
  ];
  if (report.launchable.length) {
    lines.push('Launchable content:');
    report.launchable.forEach((entry, index) => {
      lines.push(`  ${index + 1}. ${entry.title ?? entry.item} → ${entry.launchPath}${entry.parameters ?? ''} (${entry.scormType.toUpperCase()}${entry.visible ? '' : ', hidden'})`);
    });
  }
  if (report.issues.length) {
    lines.push('Issues:');
    for (const issue of report.issues) {
      const where = [issue.path ? `"${issue.path}"` : null, issue.line ? `manifest line ${issue.line}` : null, issue.value ? `value "${issue.value}"` : null].filter(Boolean).join(', ');
      lines.push(`  [${issue.severity}] ${issue.code}: ${issue.message}${where ? ` (${where})` : ''}`);
    }
  }
  lines.push(`Playback:  not available in AcademiaPath yet; ${SUPPORT_LABEL[report.runtime.plannedSupport]}.`);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), options: { cwd?: string; out?: (text: string) => void; err?: (text: string) => void } = {}): Promise<number> {
  const out = options.out ?? ((text: string) => console.log(text));
  const err = options.err ?? ((text: string) => console.error(text));
  const json = argv.includes('--json');
  const args = argv.filter((arg) => arg !== '--json' && arg !== '--');
  if (args.length !== 1 || args[0]!.startsWith('-')) {
    err(USAGE);
    return INSPECT_EXIT.usage;
  }
  // `pnpm scorm:inspect` runs in apps/api; paths are relative to where the command was typed.
  const base = options.cwd ?? process.env.INIT_CWD ?? process.cwd();
  const path = isAbsolute(args[0]!) ? args[0]! : resolve(base, args[0]!);
  const name = basename(path);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    err(`Cannot read "${displayFileName(name)}": not a readable file.`);
    return INSPECT_EXIT.usage;
  }
  // A package over the limit is reported without reading it into memory.
  const report = info.size > SCORM_LIMITS.maxPackageBytes ? oversizeReport(name, info.size) : await inspectInWorker(await readFile(path), { fileName: name });
  out(json ? JSON.stringify(report, null, 2) : summary(report));
  return report.status === 'invalid' ? INSPECT_EXIT.invalid : INSPECT_EXIT.valid;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error('The package could not be inspected.');
      process.exitCode = INSPECT_EXIT.usage;
    });
}
