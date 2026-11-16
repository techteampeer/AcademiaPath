import { createHash } from 'node:crypto';
import { MANIFEST_PATH, scanArchive, type ArchiveScan } from './archive.js';
import { SCORM_LIMITS } from './limits.js';
import { analyzeManifest, decodeManifest, ManifestFailure, parseManifestXml, type ManifestAnalysis } from './manifest.js';
import { clean, IssueList, type ScormInspectionReport, type ScormIssueCode } from './report.js';

/**
 * AP-033B: inspects one untrusted SCORM package held in memory and returns a bounded report. Read-only: nothing is
 * written, stored, executed or fetched. Used by the dry-run API (in a worker) and by `pnpm scorm:inspect`.
 */
export async function inspectPackage(bytes: Buffer, options: { fileName?: string | null } = {}): Promise<ScormInspectionReport> {
  const issues = new IssueList();
  if (bytes.length > SCORM_LIMITS.maxPackageBytes) {
    issues.error('SCORM_PACKAGE_TOO_LARGE', { limit: SCORM_LIMITS.maxPackageBytes });
    return buildReport(factsOf(bytes), options.fileName, null, null, issues);
  }
  const archive = await scanArchive(bytes, issues);
  if (!archive.safe) return buildReport(factsOf(bytes), options.fileName, archive, null, issues);

  if (!archive.manifest) {
    if (archive.manifestTooLarge) {
      issues.error('SCORM_MANIFEST_TOO_LARGE', { limit: SCORM_LIMITS.maxManifestBytes });
    } else {
      const variant = [...archive.files.keys()].find((path) => path.split('/').at(-1)?.toLowerCase() === MANIFEST_PATH);
      if (variant?.includes('/')) issues.error('SCORM_MANIFEST_NOT_AT_ROOT', { path: variant });
      else issues.error('SCORM_MANIFEST_MISSING', { path: variant ?? null });
    }
    return buildReport(factsOf(bytes), options.fileName, archive, null, issues);
  }
  const xml = decodeManifest(archive.manifest);
  if (xml === null) {
    issues.error('SCORM_MANIFEST_ENCODING');
    return buildReport(factsOf(bytes), options.fileName, archive, null, issues);
  }
  let analysis: ManifestAnalysis | null = null;
  try {
    analysis = analyzeManifest(parseManifestXml(xml), archive, issues);
  } catch (error) {
    if (!(error instanceof ManifestFailure)) throw error;
    issues.error(error.code, { line: error.line, limit: error.limit });
  }
  return buildReport(factsOf(bytes), options.fileName, archive, analysis, issues);
}

/** The display name of an uploaded file: its last path segment, cleaned and shortened (never a server path). */
export const displayFileName = (name: string | null | undefined) => clean(name?.split(/[\\/]/).at(-1) ?? null, 200);

type PackageFacts = { sha256: string; size: number };
const factsOf = (bytes: Uint8Array): PackageFacts => ({ sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength });

function buildReport(facts: PackageFacts, fileName: string | null | undefined, archive: ArchiveScan | null, analysis: ManifestAnalysis | null, issues: IssueList): ScormInspectionReport {
  const supported = analysis?.supported === true;
  const status = issues.errors > 0 ? 'invalid' : issues.warnings > 0 ? 'valid_with_warnings' : 'valid';
  const plannedSupport = status === 'invalid' || !supported ? 'not_supported' : analysis?.features.sequencing ? 'planned_without_sequencing' : 'planned';
  return {
    reportVersion: 1,
    status,
    imported: false,
    package: {
      fileName: displayFileName(fileName),
      sha256: facts.sha256,
      compressedBytes: facts.size,
      uncompressedBytes: archive?.uncompressedBytes ?? null,
      fileCount: archive?.fileCount ?? 0,
      folderCount: archive?.folderCount ?? 0,
    },
    standard: analysis?.standard ?? { format: 'unknown', version: null, edition: null, schemaVersion: null },
    title: analysis?.title ?? null,
    manifestIdentifier: analysis?.manifestIdentifier ?? null,
    counts: analysis?.counts ?? { organizations: 0, items: 0, resources: 0, scos: 0, assets: 0, launchable: 0, declaredFiles: 0, missingFiles: 0, undeclaredFiles: archive?.files.size ?? 0 },
    organizations: analysis?.organizations ?? [],
    launchable: analysis?.launchable ?? [],
    resources: analysis?.resources ?? [],
    features: analysis?.features ?? { sequencing: false, subManifests: false },
    runtime: { playbackAvailable: false, plannedSupport },
    issues: issues.items,
    issuesTruncated: issues.truncated,
    listsTruncated: analysis?.listsTruncated ?? false,
  };
}

/** The report for a package whose inspection could not finish (time or memory limit, or an internal failure). */
export function failureReport(bytes: Uint8Array, fileName: string | null | undefined, code: Extract<ScormIssueCode, 'SCORM_INSPECTION_LIMIT' | 'SCORM_INSPECTION_FAILED'>): ScormInspectionReport {
  const issues = new IssueList();
  issues.error(code);
  return buildReport(factsOf(bytes), fileName, null, null, issues);
}

/**
 * The report for a package over the size limit, built from its size alone (the file is never read into memory,
 * so no checksum is computed: `sha256` is empty).
 */
export function oversizeReport(fileName: string | null | undefined, size: number): ScormInspectionReport {
  const issues = new IssueList();
  issues.error('SCORM_PACKAGE_TOO_LARGE', { limit: SCORM_LIMITS.maxPackageBytes });
  return buildReport({ sha256: '', size }, fileName, null, null, issues);
}
