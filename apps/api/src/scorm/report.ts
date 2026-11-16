import { SCORM_LIMITS } from './limits.js';

/**
 * AP-033B inspection report. It describes a package's structure only: nothing in it is imported, stored, published
 * or executed. Strings taken from the package (titles, identifiers, paths) are cleaned and shortened.
 */
export type ScormIssueSeverity = 'error' | 'warning';

/** English messages; the web interface shows its own English and Spanish text for each code. */
export const ISSUE_MESSAGES = {
  // Archive
  SCORM_PACKAGE_TOO_LARGE: 'The package is larger than the inspection limit.',
  SCORM_ARCHIVE_INVALID: 'The file is not a readable ZIP archive.',
  SCORM_ARCHIVE_TOO_MANY_ENTRIES: 'The archive contains more files and folders than allowed.',
  SCORM_ARCHIVE_TOO_LARGE: 'The archive expands to more data than allowed (possible ZIP bomb).',
  SCORM_ENTRY_TOO_LARGE: 'A file in the archive expands to more data than allowed.',
  SCORM_ENTRY_EXPANSION_RATIO: 'A file in the archive is compressed far more than normal content (possible ZIP bomb).',
  SCORM_ENTRY_CORRUPT: 'A file in the archive is damaged: its size or checksum does not match.',
  SCORM_ENTRY_ENCRYPTED: 'The archive contains an encrypted file.',
  SCORM_ENTRY_SYMLINK: 'The archive contains a symbolic link.',
  SCORM_ENTRY_SPECIAL_FILE: 'The archive contains a device, pipe or other special file.',
  SCORM_ENTRY_COMPRESSION_UNSUPPORTED: 'A file in the archive uses an unsupported compression method.',
  SCORM_PATH_TRAVERSAL: 'A file name in the archive points outside the package ("..").',
  SCORM_PATH_ABSOLUTE: 'A file name in the archive is an absolute path.',
  SCORM_PATH_INVALID: 'A file name in the archive contains invalid or dangerous characters, or is too long or deep.',
  SCORM_PATH_DUPLICATE: 'The archive contains the same file name more than once.',
  SCORM_PATH_COLLISION: 'Two file names in the archive differ only in letter case or Unicode form.',
  // Manifest
  SCORM_MANIFEST_MISSING: 'There is no imsmanifest.xml at the root of the package.',
  SCORM_MANIFEST_NOT_AT_ROOT: 'imsmanifest.xml is inside a folder: zip the contents of the folder, not the folder itself.',
  SCORM_MANIFEST_TOO_LARGE: 'imsmanifest.xml is larger than allowed.',
  SCORM_MANIFEST_ENCODING: 'imsmanifest.xml uses an unsupported or invalid character encoding.',
  SCORM_MANIFEST_MALFORMED: 'imsmanifest.xml is not well-formed XML.',
  SCORM_MANIFEST_DOCTYPE: 'imsmanifest.xml contains a document type declaration, which is not accepted.',
  SCORM_MANIFEST_TOO_DEEP: 'imsmanifest.xml is nested more deeply than allowed.',
  SCORM_MANIFEST_TOO_MANY_ELEMENTS: 'imsmanifest.xml contains more elements or attributes than allowed.',
  SCORM_MANIFEST_NOT_A_MANIFEST: 'imsmanifest.xml does not contain a <manifest> root element.',
  SCORM_MANIFEST_NAMESPACE_UNKNOWN: 'The manifest uses an unexpected namespace; it was inspected anyway.',
  // Standard and version
  SCORM_COMMON_CARTRIDGE: 'This is an IMS Common Cartridge (for example a Canvas course export), not a SCORM package.',
  SCORM_VERSION_UNSUPPORTED: 'The package declares a SCORM version that is not supported.',
  SCORM_VERSION_UNKNOWN: 'The package does not identify itself as SCORM 1.2 or SCORM 2004.',
  SCORM_VERSION_INFERRED: 'The manifest does not declare its SCORM version; it was inferred from its namespaces.',
  SCORM_VERSION_MISMATCH: 'The declared SCORM version does not match the namespaces the manifest uses.',
  SCORM_METADATA_SCHEMA_UNEXPECTED: 'The manifest metadata does not name the "ADL SCORM" schema.',
  // Structure
  SCORM_NO_ORGANIZATIONS: 'The manifest has no organization, so it has no course structure to launch.',
  SCORM_DEFAULT_ORGANIZATION_INVALID: 'The default organization does not exist.',
  SCORM_DEFAULT_ORGANIZATION_MISSING: 'No default organization is set; the first one is used.',
  SCORM_IDENTIFIER_MISSING: 'An organization, item or resource has no identifier.',
  SCORM_IDENTIFIER_DUPLICATE: 'The same identifier is used more than once.',
  SCORM_ITEM_REFERENCE_INVALID: 'An item refers to a resource that does not exist.',
  SCORM_ITEM_WITHOUT_RESOURCE: 'An item has neither child items nor a resource to launch.',
  SCORM_RESOURCE_TYPE_UNSUPPORTED: 'A resource is not of type "webcontent".',
  SCORM_SCORMTYPE_MISSING: 'A resource does not say whether it is a SCO or an asset; it is treated as an asset.',
  SCORM_SCORMTYPE_INVALID: 'A resource has an unknown SCORM type; it is treated as an asset.',
  SCORM_DEPENDENCY_INVALID: 'A resource depends on a resource that does not exist.',
  SCORM_LAUNCH_HREF_MISSING: 'A launchable item refers to a resource without a launch file.',
  SCORM_LAUNCH_FILE_MISSING: 'A launch file is not in the package.',
  SCORM_FILE_MISSING: 'A file listed in the manifest is not in the package.',
  SCORM_FILE_CASE_MISMATCH: 'A file is referenced with different letter case than its name in the package.',
  SCORM_HREF_EXTERNAL: 'A resource refers to an external web address; external content is not loaded.',
  SCORM_HREF_DANGEROUS: 'A resource refers to a dangerous address (for example javascript: or data:).',
  SCORM_HREF_INVALID: 'A resource address is not a valid relative path.',
  SCORM_HREF_OUTSIDE_PACKAGE: 'A resource address points outside the package.',
  SCORM_HREF_BACKSLASH: 'A resource address uses backslashes; they were read as forward slashes.',
  SCORM_LAUNCH_NOT_HTML: 'A launch file is not an HTML page.',
  SCORM_LAUNCH_FLASH: 'A launch file is Flash content, which modern browsers cannot play.',
  SCORM_NO_LAUNCHABLE_CONTENT: 'The package has no item that can be launched.',
  SCORM_SEQUENCING_IGNORED: 'The package defines SCORM 2004 sequencing rules; they will not be applied.',
  SCORM_SUBMANIFEST_UNSUPPORTED: 'The package contains nested (sub-)manifests, which are not supported.',
  // Inspection
  SCORM_INSPECTION_LIMIT: 'Inspecting the package took too long or needed too much memory.',
  SCORM_INSPECTION_FAILED: 'The package could not be inspected.',
} as const;

export type ScormIssueCode = keyof typeof ISSUE_MESSAGES;
export const ISSUE_CODES = Object.keys(ISSUE_MESSAGES) as ScormIssueCode[];

export type ScormIssue = {
  code: ScormIssueCode;
  severity: ScormIssueSeverity;
  message: string;
  /** Package-relative file path or manifest href the issue is about. */
  path: string | null;
  /** Line in imsmanifest.xml. */
  line: number | null;
  /** The limit that was exceeded. */
  limit: number | null;
  /** A short value from the package (an identifier, a declared version, an address scheme). */
  value: string | null;
};

export type ScormVersion = 'scorm_1_2' | 'scorm_2004';
export type ScormEdition = '2nd' | '3rd' | '4th';

export type ScormInspectionReport = {
  reportVersion: 1;
  status: 'valid' | 'valid_with_warnings' | 'invalid';
  /** Always false: inspection never imports, stores or publishes anything. */
  imported: false;
  package: {
    fileName: string | null;
    sha256: string;
    compressedBytes: number;
    /** Verified decompressed size of all files; null when the archive could not be read. */
    uncompressedBytes: number | null;
    fileCount: number;
    folderCount: number;
  };
  standard: {
    format: 'scorm' | 'common_cartridge' | 'unknown';
    version: ScormVersion | null;
    edition: ScormEdition | null;
    /** The manifest's declared schema version, as written. */
    schemaVersion: string | null;
  };
  title: string | null;
  manifestIdentifier: string | null;
  counts: {
    organizations: number;
    items: number;
    resources: number;
    scos: number;
    assets: number;
    launchable: number;
    declaredFiles: number;
    missingFiles: number;
    /** Files in the archive that no resource lists (common, and not an error). */
    undeclaredFiles: number;
  };
  organizations: Array<{ identifier: string; title: string | null; isDefault: boolean; itemCount: number }>;
  launchable: Array<{
    organization: string;
    item: string;
    title: string | null;
    resource: string;
    scormType: 'sco' | 'asset';
    launchPath: string;
    parameters: string | null;
    visible: boolean;
  }>;
  resources: Array<{
    identifier: string;
    scormType: 'sco' | 'asset';
    launchPath: string | null;
    fileCount: number;
    missingFileCount: number;
    dependencyCount: number;
  }>;
  features: { sequencing: boolean; subManifests: boolean };
  runtime: {
    /** SCORM playback does not exist in AcademiaPath yet. */
    playbackAvailable: false;
    /** What later milestones are expected to support for this package. */
    plannedSupport: 'planned' | 'planned_without_sequencing' | 'not_supported';
  };
  issues: ScormIssue[];
  issuesTruncated: boolean;
  /** Organizations, launchable items or resources were cut to the listing limit (counts stay complete). */
  listsTruncated: boolean;
};

/** Removes control characters and shortens a string taken from the package. */
export function clean(value: string | null | undefined, max = 300): string | null {
  if (value == null) return null;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Collects issues up to the report limit; counts keep growing so truncation is visible. */
export class IssueList {
  readonly items: ScormIssue[] = [];
  errors = 0;
  warnings = 0;
  truncated = false;

  add(code: ScormIssueCode, severity: ScormIssueSeverity, details: { path?: string | null; line?: number | null; limit?: number | null; value?: string | null } = {}) {
    if (severity === 'error') this.errors += 1;
    else this.warnings += 1;
    if (this.items.length >= SCORM_LIMITS.maxIssues) {
      this.truncated = true;
      return;
    }
    this.items.push({
      code,
      severity,
      message: ISSUE_MESSAGES[code],
      path: clean(details.path ?? null),
      line: details.line ?? null,
      limit: details.limit ?? null,
      value: clean(details.value ?? null, 120),
    });
  }

  error(code: ScormIssueCode, details?: Parameters<IssueList['add']>[2]) {
    this.add(code, 'error', details);
  }

  warning(code: ScormIssueCode, details?: Parameters<IssueList['add']>[2]) {
    this.add(code, 'warning', details);
  }

  has(code: ScormIssueCode) {
    return this.items.some((issue) => issue.code === code);
  }
}
