/**
 * AP-033B: bounds for inspecting one untrusted SCORM package. Every limit is enforced before or while the archive is
 * read, so a hostile package cannot make inspection use unbounded memory, disk or time.
 */
export const SCORM_LIMITS = {
  /** Uploaded (compressed) package. */
  maxPackageBytes: 25 * 1024 * 1024,
  /** Entries in the ZIP central directory (files and folders). */
  maxEntries: 10_000,
  /** One decompressed file. */
  maxEntryBytes: 100 * 1024 * 1024,
  /** All decompressed files together. */
  maxTotalBytes: 250 * 1024 * 1024,
  /** Largest expansion (decompressed / compressed size) of one entry, checked for entries of at least ratioCheckFromBytes. */
  maxExpansionRatio: 100,
  ratioCheckFromBytes: 1024 * 1024,
  /** One entry name: UTF-8 bytes and folder depth. */
  maxPathBytes: 512,
  maxPathDepth: 32,
  /** imsmanifest.xml. */
  maxManifestBytes: 2 * 1024 * 1024,
  maxXmlDepth: 64,
  maxXmlElements: 50_000,
  maxXmlAttributes: 64,
  /** Text kept per XML element (titles, schema version); longer text is cut. */
  maxXmlText: 4_000,
  /** Report size: listed items, resources and issues (the counts are always complete). */
  maxListed: 500,
  maxIssues: 200,
  /** Inspection worker. */
  timeoutMs: 30_000,
  workerHeapMb: 256,
  maxConcurrent: 2,
} as const;
