import { ARCHIVE_PROBLEMS, type ArchiveIssueSink, type ArchiveProblem } from '../scorm/archive.js';
import { SCORM_LIMITS } from '../scorm/limits.js';
import { clean } from '../scorm/report.js';

/**
 * AP-038D: the dry-run inspection report for an IMS Common Cartridge (.imscc) package, typically a Canvas course
 * export. Nothing in it means "importable": it describes what the package contains, how each resource relates to
 * AcademiaPath's existing capabilities, and what is unsupported, broken or unsafe.
 */
export const CARTRIDGE_LIMITS = {
  /** The archive limits are those of the shared archive scanner (SCORM_LIMITS): 25 MB upload, 10,000 entries, ... */
  maxPackageBytes: SCORM_LIMITS.maxPackageBytes,
  /** Resource descriptors (QTI, discussion, web link, LTI, Canvas settings) and HTML pages read for the report. */
  maxDescriptorBytes: 1024 * 1024,
  maxDescriptorTotalBytes: 24 * 1024 * 1024,
  /** Report size: listed modules, items, resources and issues (counts are always complete). */
  maxListed: 500,
  maxIssues: 200,
  /** Broken references reported per HTML page (all are counted). */
  maxLinkIssuesPerPage: 3,
  timeoutMs: 30_000,
  workerHeapMb: 256,
} as const;

export const CARTRIDGE_ISSUE_MESSAGES = {
  // Archive safety (shared scanner, AP-033B)
  CARTRIDGE_ARCHIVE_INVALID: 'The file is not a readable ZIP archive.',
  CARTRIDGE_ARCHIVE_TOO_MANY_ENTRIES: 'The archive has more entries than the inspection limit.',
  CARTRIDGE_ARCHIVE_TOO_LARGE: 'The archive expands beyond the total size limit.',
  CARTRIDGE_ARCHIVE_EMPTY: 'The archive contains no files.',
  CARTRIDGE_PATH_TRAVERSAL: 'An entry name leaves the package folder ("..").',
  CARTRIDGE_PATH_ABSOLUTE: 'An entry name is an absolute path.',
  CARTRIDGE_PATH_INVALID: 'An entry name is not a valid package path.',
  CARTRIDGE_PATH_DUPLICATE: 'Two entries have the same name.',
  CARTRIDGE_PATH_COLLISION: 'Two entries have names that differ only in letter case or Unicode form.',
  CARTRIDGE_ENTRY_ENCRYPTED: 'An entry is encrypted.',
  CARTRIDGE_ENTRY_SYMLINK: 'An entry is a symbolic link.',
  CARTRIDGE_ENTRY_SPECIAL_FILE: 'An entry is not a regular file or folder.',
  CARTRIDGE_ENTRY_COMPRESSION_UNSUPPORTED: 'An entry uses an unsupported compression method.',
  CARTRIDGE_ENTRY_TOO_LARGE: 'An entry expands beyond the per-file size limit.',
  CARTRIDGE_ENTRY_EXPANSION_RATIO: 'An entry expands far more than its compressed size (possible ZIP bomb).',
  CARTRIDGE_ENTRY_CORRUPT: 'An entry is damaged or its declared size or checksum is wrong.',
  // Manifest
  CARTRIDGE_MANIFEST_MISSING: 'imsmanifest.xml is missing from the package root.',
  CARTRIDGE_MANIFEST_NESTED: 'imsmanifest.xml is inside a folder; it must be at the package root.',
  CARTRIDGE_MANIFEST_TOO_LARGE: 'imsmanifest.xml is larger than the inspection limit.',
  CARTRIDGE_MANIFEST_ENCODING: 'imsmanifest.xml uses an unsupported or invalid text encoding.',
  CARTRIDGE_MANIFEST_MALFORMED: 'imsmanifest.xml is not well-formed XML.',
  CARTRIDGE_MANIFEST_DOCTYPE: 'imsmanifest.xml declares a DOCTYPE, which is refused (entities are never expanded or fetched).',
  CARTRIDGE_MANIFEST_TOO_DEEP: 'imsmanifest.xml is nested more deeply than the inspection limit.',
  CARTRIDGE_MANIFEST_TOO_MANY_ELEMENTS: 'imsmanifest.xml has more elements or attributes than the inspection limit.',
  CARTRIDGE_MANIFEST_ROOT_INVALID: 'The root element of imsmanifest.xml is not <manifest>.',
  // Format and version
  CARTRIDGE_IS_SCORM: 'This is a SCORM package, not a Common Cartridge. Use the SCORM inspection instead.',
  CARTRIDGE_NOT_CARTRIDGE: 'The manifest does not declare an IMS Common Cartridge.',
  CARTRIDGE_VERSION_UNSUPPORTED: 'This Common Cartridge version is not supported by the inspector (supported: 1.0, 1.1, 1.2 and 1.3).',
  CARTRIDGE_VERSION_UNDECLARED: 'The manifest does not declare its schema version; it was identified from the manifest namespace.',
  CARTRIDGE_VERSION_MISMATCH: 'The declared schema version and the manifest namespace name different Common Cartridge versions.',
  CARTRIDGE_THIN: 'This is a Thin Common Cartridge: it holds links and LTI references, not course content.',
  CARTRIDGE_CANVAS_EXTENSIONS: 'The package contains Canvas-specific extensions that are not part of the Common Cartridge standard.',
  // Organization and resources
  CARTRIDGE_ORGANIZATION_MISSING: 'The manifest has no organization, so there is no course outline (module structure).',
  CARTRIDGE_ORGANIZATION_MULTIPLE: 'The manifest has more than one organization; only the first is inspected.',
  CARTRIDGE_ORGANIZATION_NESTED: 'The outline nests items more than one level inside modules; AcademiaPath sections are one level deep.',
  CARTRIDGE_ITEM_RESOURCE_MISSING: 'An outline item refers to a resource that does not exist.',
  CARTRIDGE_RESOURCES_EMPTY: 'The manifest lists no resources.',
  CARTRIDGE_RESOURCE_IDENTIFIER_MISSING: 'A resource has no identifier.',
  CARTRIDGE_RESOURCE_IDENTIFIER_DUPLICATE: 'Two resources have the same identifier.',
  CARTRIDGE_RESOURCE_FILE_MISSING: 'A resource refers to a file that is not in the package.',
  CARTRIDGE_RESOURCE_HREF_OUTSIDE: 'A resource reference leaves the package folder.',
  CARTRIDGE_RESOURCE_HREF_DANGEROUS: 'A resource reference uses a dangerous scheme (javascript:, data:, file: or similar).',
  CARTRIDGE_RESOURCE_HREF_INVALID: 'A resource reference is not a valid package path.',
  CARTRIDGE_RESOURCE_HREF_EXTERNAL: 'A resource that should be packaged points to an external address instead (it was not fetched).',
  CARTRIDGE_DEPENDENCY_MISSING: 'A resource depends on a resource that does not exist.',
  CARTRIDGE_RESOURCE_TYPE_UNKNOWN: 'A resource has a type the inspector does not recognize.',
  CARTRIDGE_RESOURCE_INLINE: 'A resource describes its content inline in the manifest; inline descriptors are not inspected.',
  // Resource descriptors and content
  CARTRIDGE_DESCRIPTOR_MALFORMED: 'A resource descriptor is not well-formed XML.',
  CARTRIDGE_DESCRIPTOR_DOCTYPE: 'A resource descriptor declares a DOCTYPE, which is refused.',
  CARTRIDGE_DESCRIPTOR_LIMIT: 'A resource descriptor or page exceeds the inspection limits and was not read.',
  CARTRIDGE_QTI_VERSION_UNSUPPORTED: 'An assessment uses a QTI version other than QTI 1.2, which the inspector does not read.',
  CARTRIDGE_QUESTION_TYPE_UNSUPPORTED: 'An assessment uses question types that AcademiaPath quizzes do not support.',
  CARTRIDGE_ASSESSMENT_EMPTY: 'An assessment contains no questions.',
  CARTRIDGE_LINK_BROKEN: 'A page refers to a file that is not in the package.',
  CARTRIDGE_LINK_DANGEROUS: 'A page or link uses a dangerous scheme (javascript:, data:, file: or similar).',
  CARTRIDGE_WEBLINK_INSECURE: 'A web link is not https; AcademiaPath links must use https.',
  // Inspection
  CARTRIDGE_INSPECTION_FAILED: 'The package could not be inspected.',
  CARTRIDGE_INSPECTION_LIMIT: 'Inspection stopped at its time or memory limit.',
} as const;

export type CartridgeIssueCode = keyof typeof CARTRIDGE_ISSUE_MESSAGES;
export const CARTRIDGE_ISSUE_CODES = Object.keys(CARTRIDGE_ISSUE_MESSAGES) as CartridgeIssueCode[];
export type CartridgeIssueSeverity = 'error' | 'warning';
export type CartridgeIssue = {
  code: CartridgeIssueCode;
  severity: CartridgeIssueSeverity;
  message: string;
  path: string | null;
  line: number | null;
  limit: number | null;
  value: string | null;
};

export type CartridgeVersion = '1.0' | '1.1' | '1.2' | '1.3';
export type CartridgeFormat = 'common_cartridge' | 'thin_common_cartridge' | 'scorm' | 'ims_content_package' | 'unknown';
export const RESOURCE_KINDS = [
  'page',
  'file',
  'assessment',
  'question_bank',
  'assignment',
  'discussion',
  'web_link',
  'lti_link',
  'canvas_settings',
  'learning_application',
  'other_standard',
  'unknown',
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const CLASSIFICATIONS = ['recognized', 'mappable', 'transform', 'unsupported', 'invalid'] as const;
/** recognized: understood, no own counterpart (assets, settings); mappable: potentially maps to an existing feature;
 *  transform: needs conversion before it could map; unsupported: no counterpart; invalid: broken or unsafe. */
export type Classification = (typeof CLASSIFICATIONS)[number];
export type Target = 'section' | 'lesson' | 'document' | 'quiz' | 'assignment' | 'forum' | 'link' | null;
export type Support = 'direct' | 'transform' | 'new_functionality' | 'unsupported';

export type QuestionTypeCount = { type: string; count: number; supported: boolean };
export type CartridgeResource = {
  identifier: string | null;
  /** The declared type, as written (cleaned). */
  type: string | null;
  kind: ResourceKind;
  classification: Classification;
  target: Target;
  title: string | null;
  href: string | null;
  /** A Canvas-specific variant or file (not defined by the Common Cartridge standard). */
  canvas: boolean;
  /** Placed in the course outline (organization). */
  inOutline: boolean;
  fileCount: number;
  missingFileCount: number;
  dependencyCount: number;
  questionCount: number | null;
  questionTypes: QuestionTypeCount[];
  /** Web link or LTI launch address, as written (never fetched). */
  url: string | null;
  submissionTypes: string[];
  externalLinks: number;
  brokenLinks: number;
  canvasLinks: number;
};

export type OutlineItem = { title: string | null; identifierref: string | null; kind: ResourceKind | null; classification: Classification | null; depth: number };
export type OutlineModule = { title: string | null; itemCount: number; items: OutlineItem[] };

export type CartridgeInspectionReport = {
  status: 'valid' | 'valid_with_warnings' | 'invalid';
  /** Always false: this is a dry run. Nothing is imported, stored, published or executed. */
  imported: false;
  format: CartridgeFormat;
  version: CartridgeVersion | null;
  declared: { schema: string | null; schemaVersion: string | null; namespace: string | null };
  canvas: { detected: boolean; signals: string[] };
  title: string | null;
  description: string | null;
  language: string | null;
  package: { fileName: string | null; compressedBytes: number; uncompressedBytes: number | null; fileCount: number; folderCount: number };
  counts: {
    modules: number;
    outlineItems: number;
    resources: number;
    questions: number;
    externalLinks: number;
    brokenReferences: number;
    byKind: Record<ResourceKind, number>;
    byClassification: Record<Classification, number>;
  };
  modules: OutlineModule[];
  resources: CartridgeResource[];
  compatibility: Array<{ kind: ResourceKind | 'module'; count: number; target: Target; support: Support }>;
  issues: CartridgeIssue[];
  issuesTruncated: boolean;
  listsTruncated: boolean;
};

/** Collects issues up to the report limit; counts keep growing so truncation is visible. */
export class CartridgeIssues {
  readonly items: CartridgeIssue[] = [];
  errors = 0;
  warnings = 0;
  truncated = false;

  add(code: CartridgeIssueCode, severity: CartridgeIssueSeverity, details: { path?: string | null; line?: number | null; limit?: number | null; value?: string | null } = {}) {
    if (severity === 'error') this.errors += 1;
    else this.warnings += 1;
    if (this.items.length >= CARTRIDGE_LIMITS.maxIssues) {
      this.truncated = true;
      return;
    }
    this.items.push({ code, severity, message: CARTRIDGE_ISSUE_MESSAGES[code], path: clean(details.path ?? null), line: details.line ?? null, limit: details.limit ?? null, value: clean(details.value ?? null, 160) });
  }
  error(code: CartridgeIssueCode, details?: Parameters<CartridgeIssues['add']>[2]) {
    this.add(code, 'error', details);
  }
  warn(code: CartridgeIssueCode, details?: Parameters<CartridgeIssues['add']>[2]) {
    this.add(code, 'warning', details);
  }
  /** The shared archive scanner reports under CARTRIDGE_ codes (each archive problem has one, checked below). */
  archiveSink(): ArchiveIssueSink {
    return { error: (problem, details) => this.error(ARCHIVE_CODES[problem], details) };
  }
}

const ARCHIVE_CODES = Object.fromEntries(ARCHIVE_PROBLEMS.map((problem) => [problem, `CARTRIDGE_${problem}`])) as Record<ArchiveProblem, `CARTRIDGE_${ArchiveProblem}`>;
// Compile-time check: every archive problem has a CARTRIDGE_ message.
const _archiveMessages: Pick<typeof CARTRIDGE_ISSUE_MESSAGES, `CARTRIDGE_${ArchiveProblem}`> = CARTRIDGE_ISSUE_MESSAGES;
void _archiveMessages;
