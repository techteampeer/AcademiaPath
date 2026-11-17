import { MANIFEST_PATH, scanArchive, type ArchiveScan } from '../scorm/archive.js';
import { displayFileName } from '../scorm/inspect.js';
import { attr, childrenNamed, decodeManifest, firstChild, parseXml, textOf, walk, xmlBase, XmlFailure, type XmlNode } from '../scorm/manifest.js';
import { resolveHref } from '../scorm/paths.js';
import { clean } from '../scorm/report.js';
import {
  CARTRIDGE_LIMITS,
  CartridgeIssues,
  CLASSIFICATIONS,
  RESOURCE_KINDS,
  type CartridgeFormat,
  type CartridgeInspectionReport,
  type CartridgeIssueCode,
  type CartridgeResource,
  type CartridgeVersion,
  type Classification,
  type OutlineItem,
  type OutlineModule,
  type QuestionTypeCount,
  type ResourceKind,
  type Support,
  type Target,
} from './report.js';

/**
 * AP-038D: read-only inspection of an untrusted IMS Common Cartridge (.imscc), such as a Canvas course export. The
 * archive goes through the shared scanner (AP-033B: names, sizes, CRC-32, symlinks, encryption, collisions, ZIP bombs);
 * every XML file is parsed without a DTD under the same bounds; HTML pages are only scanned for references. Nothing is
 * executed, fetched, extracted to disk, stored or imported.
 */
const CC_NAMESPACE_VERSIONS: Record<string, CartridgeVersion> = {
  'http://www.imsglobal.org/xsd/imscc/imscp_v1p1': '1.0',
  'http://www.imsglobal.org/xsd/imsccv1p1/imscp_v1p1': '1.1',
  'http://www.imsglobal.org/xsd/imsccv1p2/imscp_v1p1': '1.2',
  'http://www.imsglobal.org/xsd/imsccv1p3/imscp_v1p1': '1.3',
};
/** Any Common Cartridge manifest namespace, including versions the inspector does not support (e.g. imsccv1p4). */
const CC_NAMESPACE = /^https?:\/\/www\.imsglobal\.org\/xsd\/imscc(v\d+p\d+)?\//i;
const VERSION_TEXT: Record<string, CartridgeVersion> = { '1.0': '1.0', '1.0.0': '1.0', '1.1': '1.1', '1.1.0': '1.1', '1.2': '1.2', '1.2.0': '1.2', '1.3': '1.3', '1.3.0': '1.3' };
const SCORM_SIGNS = /adlnet\.org\/xsd\/adlcp|ADL SCORM/i;
const CANVAS_NAMESPACE = /canvas\.instructure\.com/i;
/** Canvas export files and folders (not part of the Common Cartridge standard). */
const CANVAS_FILES = [
  'course_settings/canvas_export.txt',
  'course_settings/course_settings.xml',
  'course_settings/module_meta.xml',
  'course_settings/assignment_groups.xml',
  'course_settings/files_meta.xml',
  'course_settings/rubrics.xml',
  'course_settings/learning_outcomes.xml',
  'course_settings/late_policy.xml',
  'course_settings/media_tracks.xml',
  'course_settings/context.xml',
  'course_settings/events.xml',
  'course_settings/syllabus.html',
];
const CANVAS_FOLDERS = ['non_cc_assessments/', 'wiki_content/', 'web_resources/'];

/** Question types by their QTI metadata (Common Cartridge cc_profile, or Canvas question_type), normalized. */
const QUESTION_TYPES: Record<string, { type: string; supported: boolean }> = {
  'cc.multiple_choice.v0p1': { type: 'multiple_choice', supported: true },
  'cc.multiple_response.v0p1': { type: 'multiple_response', supported: true },
  'cc.true_false.v0p1': { type: 'true_false', supported: true },
  'cc.fib.v0p1': { type: 'fill_in_blank', supported: false },
  'cc.pattern_match.v0p1': { type: 'pattern_match', supported: false },
  'cc.essay.v0p1': { type: 'essay', supported: false },
  multiple_choice_question: { type: 'multiple_choice', supported: true },
  multiple_answers_question: { type: 'multiple_response', supported: true },
  true_false_question: { type: 'true_false', supported: true },
  short_answer_question: { type: 'fill_in_blank', supported: false },
  fill_in_multiple_blanks_question: { type: 'fill_in_multiple_blanks', supported: false },
  multiple_dropdowns_question: { type: 'multiple_dropdowns', supported: false },
  matching_question: { type: 'matching', supported: false },
  numerical_question: { type: 'numerical', supported: false },
  calculated_question: { type: 'calculated', supported: false },
  essay_question: { type: 'essay', supported: false },
  file_upload_question: { type: 'file_upload', supported: false },
  text_only_question: { type: 'text_only', supported: false },
};
const DOCUMENT_FILES = /\.(pdf|docx|pptx)$/i;
const PAGE_FILES = /\.html?$/i;
const KEPT_FILES = /\.(xml|qti|html?)$/i;

const TARGETS: Record<ResourceKind, Target> = {
  page: 'lesson',
  file: 'document',
  assessment: 'quiz',
  question_bank: null,
  assignment: 'assignment',
  discussion: 'forum',
  web_link: 'link',
  lti_link: null,
  canvas_settings: null,
  learning_application: null,
  other_standard: null,
  unknown: null,
};
/** Unsupported kinds that would need a new AcademiaPath capability (rather than having no counterpart at all). */
const NEW_FUNCTIONALITY: ReadonlySet<ResourceKind> = new Set(['lti_link', 'question_bank', 'file', 'assessment']);

type Resource = CartridgeResource & { line: number; files: string[]; dependencies: string[]; node: XmlNode; primary: string | null };
type Facts = { fileName: string | null; compressedBytes: number };

export async function inspectCartridge(bytes: Buffer, options: { fileName?: string | null } = {}): Promise<CartridgeInspectionReport> {
  const issues = new CartridgeIssues();
  const facts: Facts = { fileName: displayFileName(options.fileName), compressedBytes: bytes.length };
  let keptBytes = 0;
  const archive = await scanArchive(bytes, issues.archiveSink(), {
    keep: (path, size) => {
      if (!KEPT_FILES.test(path) || size > CARTRIDGE_LIMITS.maxDescriptorBytes || keptBytes + size > CARTRIDGE_LIMITS.maxDescriptorTotalBytes) return false;
      keptBytes += size;
      return true;
    },
  });
  const report = baseReport(facts, archive);
  if (!archive.safe) return finish(report, issues);
  if (archive.fileCount === 0) {
    issues.error('CARTRIDGE_ARCHIVE_EMPTY');
    return finish(report, issues);
  }
  if (!archive.files.has(MANIFEST_PATH)) {
    const nested = [...archive.files.keys()].find((path) => path.toLowerCase().endsWith(`/${MANIFEST_PATH}`));
    issues.error(nested ? 'CARTRIDGE_MANIFEST_NESTED' : 'CARTRIDGE_MANIFEST_MISSING', { path: nested ?? null });
    return finish(report, issues);
  }
  if (archive.manifestTooLarge || !archive.manifest) {
    issues.error('CARTRIDGE_MANIFEST_TOO_LARGE', { path: MANIFEST_PATH });
    return finish(report, issues);
  }
  const xml = decodeManifest(archive.manifest);
  if (xml === null) {
    issues.error('CARTRIDGE_MANIFEST_ENCODING', { path: MANIFEST_PATH });
    return finish(report, issues);
  }
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch (error) {
    if (!(error instanceof XmlFailure)) throw error;
    issues.error(`CARTRIDGE_MANIFEST_${error.kind}`, { path: MANIFEST_PATH, line: error.line, limit: error.limit });
    return finish(report, issues);
  }
  analyze(root, archive, report, issues);
  return finish(report, issues);
}

/** A report for a package that could not be inspected at all (worker failure or limit). */
export function failureReport(bytes: Uint8Array, fileName: string | null, code: CartridgeIssueCode): CartridgeInspectionReport {
  const issues = new CartridgeIssues();
  issues.error(code);
  return finish(baseReport({ fileName: displayFileName(fileName), compressedBytes: bytes.length }, null), issues);
}

function baseReport(facts: Facts, archive: ArchiveScan | null): CartridgeInspectionReport {
  return {
    status: 'invalid',
    imported: false,
    format: 'unknown',
    version: null,
    declared: { schema: null, schemaVersion: null, namespace: null },
    canvas: { detected: false, signals: [] },
    title: null,
    description: null,
    language: null,
    package: { fileName: facts.fileName, compressedBytes: facts.compressedBytes, uncompressedBytes: archive?.uncompressedBytes ?? null, fileCount: archive?.fileCount ?? 0, folderCount: archive?.folderCount ?? 0 },
    counts: {
      modules: 0,
      outlineItems: 0,
      resources: 0,
      questions: 0,
      externalLinks: 0,
      brokenReferences: 0,
      byKind: Object.fromEntries(RESOURCE_KINDS.map((kind) => [kind, 0])) as Record<ResourceKind, number>,
      byClassification: Object.fromEntries(CLASSIFICATIONS.map((value) => [value, 0])) as Record<Classification, number>,
    },
    modules: [],
    resources: [],
    compatibility: [],
    issues: [],
    issuesTruncated: false,
    listsTruncated: false,
  };
}

function finish(report: CartridgeInspectionReport, issues: CartridgeIssues): CartridgeInspectionReport {
  report.issues = issues.items;
  report.issuesTruncated = issues.truncated;
  report.status = issues.errors ? 'invalid' : issues.warnings ? 'valid_with_warnings' : 'valid';
  return report;
}

/** Text of the first descendant element with this local name. */
function descendantText(node: XmlNode | undefined, local: string): string | null {
  if (!node) return null;
  for (const child of walk(node)) if (child.local === local && child.text.trim()) return child.text.trim();
  return null;
}
const lomString = (node: XmlNode | undefined) => (node ? (descendantText(node, 'string') ?? descendantText(node, 'langstring') ?? (textOf(node) || null)) : null);
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function detectFormat(root: XmlNode, report: CartridgeInspectionReport, issues: CartridgeIssues): boolean {
  const metadata = firstChild(root, 'metadata');
  const schema = textOf(firstChild(metadata, 'schema')) || null;
  const schemaVersion = textOf(firstChild(metadata, 'schemaversion')) || null;
  report.declared = { schema: clean(schema, 120), schemaVersion: clean(schemaVersion, 40), namespace: clean(root.uri || null, 200) };
  const declarations = root.attributes.map((attribute) => attribute.value).join(' ');
  if (SCORM_SIGNS.test(schema ?? '') || SCORM_SIGNS.test(declarations)) {
    report.format = 'scorm';
    issues.error('CARTRIDGE_IS_SCORM');
    return false;
  }
  const thin = /thin common cartridge/i.test(schema ?? '');
  const isCartridge = thin || /common cartridge/i.test(schema ?? '') || CC_NAMESPACE.test(root.uri);
  if (!isCartridge) {
    report.format = /imscp/i.test(root.uri) ? 'ims_content_package' : 'unknown';
    issues.error('CARTRIDGE_NOT_CARTRIDGE', { value: root.uri || null });
    return false;
  }
  report.format = thin ? 'thin_common_cartridge' : 'common_cartridge';
  const fromText = schemaVersion ? VERSION_TEXT[schemaVersion] : undefined;
  const fromNamespace = CC_NAMESPACE_VERSIONS[root.uri];
  if (schemaVersion && !fromText) {
    issues.error('CARTRIDGE_VERSION_UNSUPPORTED', { value: schemaVersion });
    return false;
  }
  if (!schemaVersion && !fromNamespace) {
    issues.error('CARTRIDGE_VERSION_UNSUPPORTED', { value: root.uri || null });
    return false;
  }
  if (!schemaVersion) issues.warn('CARTRIDGE_VERSION_UNDECLARED', { value: root.uri });
  else if (fromNamespace && fromNamespace !== fromText) issues.warn('CARTRIDGE_VERSION_MISMATCH', { value: `${schemaVersion} / ${root.uri}` });
  else if (!fromNamespace && CC_NAMESPACE.test(root.uri)) {
    // A Common Cartridge namespace the inspector does not know (e.g. a newer version): not parsed as an older one.
    issues.error('CARTRIDGE_VERSION_UNSUPPORTED', { value: root.uri });
    return false;
  }
  report.version = fromText ?? fromNamespace ?? null;
  if (thin) issues.warn('CARTRIDGE_THIN');

  const general = metadata ? [...walk(metadata)].find((node) => node.local === 'general') : undefined;
  report.title = clean(lomString(firstChild(general, 'title')), 200);
  report.description = clean(lomString(firstChild(general, 'description')), 500);
  report.language = clean(textOf(firstChild(general, 'language')) || null, 20);
  return true;
}

function detectCanvas(root: XmlNode, archive: ArchiveScan, report: CartridgeInspectionReport, issues: CartridgeIssues) {
  const signals = CANVAS_FILES.filter((path) => archive.files.has(path));
  for (const folder of CANVAS_FOLDERS) if ([...archive.files.keys()].some((path) => path.startsWith(folder))) signals.push(folder);
  if (root.attributes.some((attribute) => CANVAS_NAMESPACE.test(attribute.value))) signals.push('xmlns: canvas.instructure.com');
  const strong = signals.some((signal) => signal.startsWith('course_settings/') || signal.startsWith('non_cc_assessments/') || signal.startsWith('xmlns'));
  report.canvas = { detected: strong, signals: signals.slice(0, 20) };
  if (strong) issues.warn('CARTRIDGE_CANVAS_EXTENSIONS');
  if (!report.title) {
    const settings = readXml(archive, 'course_settings/course_settings.xml', issues, false);
    if (settings && settings !== 'limit' && settings.local === 'course') report.title = clean(textOf(firstChild(settings, 'title')) || null, 200);
  }
}

/** Parses one kept XML file; issues are reported only when `report` is set. Returns null when it cannot be read. */
function readXml(archive: ArchiveScan, path: string, issues: CartridgeIssues, report = true): XmlNode | null | 'limit' {
  const bytes = archive.kept.get(path);
  if (!bytes) {
    if (!archive.files.has(path)) return null;
    if (report) issues.warn('CARTRIDGE_DESCRIPTOR_LIMIT', { path, limit: CARTRIDGE_LIMITS.maxDescriptorBytes });
    return 'limit';
  }
  const text = decodeManifest(bytes);
  if (text === null) {
    if (report) issues.error('CARTRIDGE_DESCRIPTOR_MALFORMED', { path });
    return null;
  }
  try {
    return parseXml(text);
  } catch (error) {
    if (!(error instanceof XmlFailure)) throw error;
    if (!report) return null;
    if (error.kind === 'DOCTYPE') issues.error('CARTRIDGE_DESCRIPTOR_DOCTYPE', { path, line: error.line });
    else if (error.kind === 'MALFORMED') issues.error('CARTRIDGE_DESCRIPTOR_MALFORMED', { path, line: error.line });
    else issues.warn('CARTRIDGE_DESCRIPTOR_LIMIT', { path, line: error.line, limit: error.limit });
    return null;
  }
}

function kindOf(type: string, files: string[], dependedOnByAssessment: boolean): { kind: ResourceKind; canvas: boolean } {
  const t = type.toLowerCase();
  if (t === 'webcontent') return { kind: PAGE_FILES.test(files[0] ?? '') ? 'page' : 'file', canvas: false };
  if (/^imsdt_xmlv1p\d$/.test(t)) return { kind: 'discussion', canvas: false };
  if (/^imswl_xmlv1p\d$/.test(t)) return { kind: 'web_link', canvas: false };
  if (/^imsqti_xmlv1p2\/imscc_xmlv1p\d\/assessment$/.test(t)) return { kind: 'assessment', canvas: false };
  if (/^imsqti_xmlv1p2\/imscc_xmlv1p\d\/question-bank$/.test(t)) return { kind: 'question_bank', canvas: false };
  if (/^imsbasiclti_xmlv1p\d$/.test(t)) return { kind: 'lti_link', canvas: false };
  if (/^assignment_xmlv1p\d$/.test(t)) return { kind: 'assignment', canvas: false };
  if (/^associatedcontent\/imscc_xmlv1p\d\/learning-application-resource$/.test(t)) {
    if (files.some((path) => path.endsWith('assignment_settings.xml'))) return { kind: 'assignment', canvas: true };
    if (files.some((path) => path.startsWith('course_settings/'))) return { kind: 'canvas_settings', canvas: true };
    if (files.some((path) => path.endsWith('assessment_meta.xml'))) return { kind: dependedOnByAssessment ? 'learning_application' : 'assessment', canvas: true };
    return { kind: 'learning_application', canvas: false };
  }
  if (/iwb|epub|apip/.test(t)) return { kind: 'other_standard', canvas: false };
  return { kind: 'unknown', canvas: false };
}

function analyze(root: XmlNode, archive: ArchiveScan, report: CartridgeInspectionReport, issues: CartridgeIssues) {
  if (root.local !== 'manifest') {
    issues.error('CARTRIDGE_MANIFEST_ROOT_INVALID', { path: MANIFEST_PATH, line: root.line, value: root.local });
    return;
  }
  if (!detectFormat(root, report, issues)) return;
  detectCanvas(root, archive, report, issues);

  // Resources
  const resourcesNode = firstChild(root, 'resources');
  const nodes = childrenNamed(resourcesNode, 'resource');
  if (!nodes.length) issues.warn('CARTRIDGE_RESOURCES_EMPTY', { path: MANIFEST_PATH });
  const resources: Resource[] = [];
  const byId = new Map<string, Resource>();
  for (const node of nodes) {
    const bases = [xmlBase(root), xmlBase(resourcesNode), xmlBase(node)];
    const identifier = attr(node, 'identifier');
    const type = attr(node, 'type') ?? '';
    const resource: Resource = {
      identifier: clean(identifier, 200),
      type: clean(type, 200),
      kind: 'unknown',
      classification: 'recognized',
      target: null,
      title: null,
      href: clean(attr(node, 'href'), 300),
      canvas: false,
      inOutline: false,
      fileCount: 0,
      missingFileCount: 0,
      dependencyCount: 0,
      questionCount: null,
      questionTypes: [],
      url: null,
      submissionTypes: [],
      externalLinks: 0,
      brokenLinks: 0,
      canvasLinks: 0,
      line: node.line,
      files: [],
      dependencies: childrenNamed(node, 'dependency').map((dependency) => attr(dependency, 'identifierref') ?? ''),
      node,
      primary: null,
    };
    resource.dependencyCount = resource.dependencies.length;
    let invalid = false;
    if (!identifier) {
      issues.error('CARTRIDGE_RESOURCE_IDENTIFIER_MISSING', { path: MANIFEST_PATH, line: node.line });
      invalid = true;
    } else if (byId.has(identifier)) {
      issues.error('CARTRIDGE_RESOURCE_IDENTIFIER_DUPLICATE', { path: MANIFEST_PATH, line: node.line, value: identifier });
      invalid = true;
    } else byId.set(identifier, resource);

    // The resource's own href, then its <file> entries: each must be a safe path to a file in the package.
    const references = [...new Set([attr(node, 'href'), ...childrenNamed(node, 'file').map((file) => attr(file, 'href'))].filter((value): value is string => value !== null))];
    const seen = new Set<string>();
    for (const [index, raw] of references.entries()) {
      const result = resolveHref(raw, bases);
      const isPrimary = index === 0;
      if (result.kind === 'local') {
        if (seen.has(result.path)) continue;
        seen.add(result.path);
        resource.files.push(result.path);
        if (!archive.files.has(result.path)) {
          resource.missingFileCount += 1;
          issues.add('CARTRIDGE_RESOURCE_FILE_MISSING', isPrimary ? 'error' : 'warning', { path: result.path, line: node.line });
          if (isPrimary) invalid = true;
        }
      } else if (result.kind === 'external') {
        issues.warn('CARTRIDGE_RESOURCE_HREF_EXTERNAL', { path: MANIFEST_PATH, line: node.line, value: result.value });
        if (isPrimary) invalid = true;
      } else {
        issues.error(result.kind === 'dangerous' ? 'CARTRIDGE_RESOURCE_HREF_DANGEROUS' : result.kind === 'outside' ? 'CARTRIDGE_RESOURCE_HREF_OUTSIDE' : 'CARTRIDGE_RESOURCE_HREF_INVALID', {
          path: MANIFEST_PATH,
          line: node.line,
          value: raw,
        });
        invalid = true;
      }
    }
    resource.fileCount = resource.files.length;
    resource.primary = resource.files[0] ?? null;
    if (node.children.some((child) => !['metadata', 'file', 'dependency'].includes(child.local))) {
      issues.warn('CARTRIDGE_RESOURCE_INLINE', { path: MANIFEST_PATH, line: node.line, value: identifier });
    }
    if (invalid) resource.classification = 'invalid';
    resources.push(resource);
  }

  // Dependencies, and which resources assessments depend on (Canvas quiz settings).
  const dependedOnByAssessment = new Set<string>();
  const referenced = new Set<string>();
  for (const resource of resources) {
    for (const dependency of resource.dependencies) {
      if (!byId.has(dependency)) {
        issues.error('CARTRIDGE_DEPENDENCY_MISSING', { path: MANIFEST_PATH, line: resource.line, value: dependency || null });
        continue;
      }
      referenced.add(dependency);
      if (/\/assessment$/i.test(resource.type ?? '')) dependedOnByAssessment.add(dependency);
    }
  }
  for (const resource of resources) {
    const detected = kindOf(resource.type ?? '', resource.files, dependedOnByAssessment.has(resource.identifier ?? ''));
    resource.kind = detected.kind;
    resource.canvas = detected.canvas;
    if (resource.kind === 'unknown') issues.warn('CARTRIDGE_RESOURCE_TYPE_UNKNOWN', { path: MANIFEST_PATH, line: resource.line, value: resource.type });
  }
  // Assessments with Canvas quiz settings are Canvas variants.
  for (const resource of resources) {
    if (resource.kind === 'assessment' && resource.dependencies.some((id) => byId.get(id)?.canvas)) resource.canvas = true;
  }

  // Course outline
  const organizations = childrenNamed(firstChild(root, 'organizations'), 'organization');
  if (!organizations.length) issues.warn('CARTRIDGE_ORGANIZATION_MISSING', { path: MANIFEST_PATH });
  if (organizations.length > 1) issues.warn('CARTRIDGE_ORGANIZATION_MULTIPLE', { path: MANIFEST_PATH });
  let top = childrenNamed(organizations[0], 'item');
  // Common Cartridge uses one root item (e.g. "LearningModules") whose children are the modules.
  if (top.length === 1 && !attr(top[0]!, 'identifierref') && childrenNamed(top[0], 'item').length) top = childrenNamed(top[0], 'item');
  let listed = 0;
  let nested = false;
  const modules: OutlineModule[] = [];
  const visit = (item: XmlNode, depth: number, module: OutlineModule) => {
    const ref = attr(item, 'identifierref');
    const resource = ref ? byId.get(ref) : undefined;
    if (ref && !resource) issues.error('CARTRIDGE_ITEM_RESOURCE_MISSING', { path: MANIFEST_PATH, line: item.line, value: ref });
    const title = clean(textOf(firstChild(item, 'title')) || null, 200);
    if (resource) {
      resource.inOutline = true;
      resource.title ??= title;
    }
    if (depth >= 2) nested = true;
    module.itemCount += 1;
    if (listed < CARTRIDGE_LIMITS.maxListed) {
      module.items.push({ title, identifierref: clean(ref, 200), kind: resource?.kind ?? null, classification: null, depth } satisfies OutlineItem);
      listed += 1;
    } else report.listsTruncated = true;
    for (const child of childrenNamed(item, 'item')) visit(child, depth + 1, module);
  };
  for (const item of top) {
    const module: OutlineModule = { title: clean(textOf(firstChild(item, 'title')) || null, 200), itemCount: 0, items: [] };
    if (attr(item, 'identifierref')) visit(item, 0, module);
    else for (const child of childrenNamed(item, 'item')) visit(child, 1, module);
    modules.push(module);
  }
  if (nested) issues.warn('CARTRIDGE_ORGANIZATION_NESTED', { path: MANIFEST_PATH });

  // Descriptors, content and classification
  for (const resource of resources) {
    if (resource.classification !== 'invalid') classify(resource, archive, issues, referenced);
    resource.target = resource.classification === 'invalid' ? null : resource.kind === 'file' && !DOCUMENT_FILES.test(resource.primary ?? '') ? null : TARGETS[resource.kind];
    resource.title ??= clean(resource.primary?.split('/').at(-1) ?? null, 200);
  }
  const classificationOf = new Map(resources.map((resource) => [resource.identifier, resource.classification]));
  for (const module of modules) for (const item of module.items) item.classification = item.identifierref ? (classificationOf.get(item.identifierref) ?? null) : null;

  // Counts, listings and the compatibility summary
  report.modules = modules.slice(0, CARTRIDGE_LIMITS.maxListed);
  report.counts.modules = modules.length;
  report.counts.outlineItems = modules.reduce((sum, module) => sum + module.itemCount, 0);
  report.counts.resources = resources.length;
  for (const resource of resources) {
    report.counts.byKind[resource.kind] += 1;
    report.counts.byClassification[resource.classification] += 1;
    report.counts.questions += resource.questionCount ?? 0;
    report.counts.externalLinks += resource.externalLinks;
    report.counts.brokenReferences += resource.brokenLinks + resource.missingFileCount;
  }
  if (resources.length > CARTRIDGE_LIMITS.maxListed || modules.length > CARTRIDGE_LIMITS.maxListed) report.listsTruncated = true;
  report.resources = resources.slice(0, CARTRIDGE_LIMITS.maxListed).map(({ line: _line, files: _files, dependencies: _dependencies, node: _node, primary: _primary, ...rest }) => rest);
  report.compatibility = compatibility(modules.length, nested, resources);
}

function classify(resource: Resource, archive: ArchiveScan, issues: CartridgeIssues, referenced: Set<string>) {
  const primary = resource.primary;
  const set = (classification: Classification) => {
    resource.classification = classification;
  };
  switch (resource.kind) {
    case 'page': {
      set('transform');
      if (primary) scanPage(primary, archive, resource, issues);
      return;
    }
    case 'file':
      set(DOCUMENT_FILES.test(primary ?? '') ? 'mappable' : resource.inOutline ? 'unsupported' : 'recognized');
      return;
    case 'assessment':
    case 'question_bank': {
      const qtiPath = resource.canvas && resource.kind === 'assessment' && !/\/assessment$/i.test(resource.type ?? '')
        ? (resource.files.find((path) => /^non_cc_assessments\/.+\.qti$/i.test(path)) ?? primary)
        : primary;
      const qti = qtiPath ? readXml(archive, qtiPath, issues) : null;
      if (qti === null) return set(qtiPath && archive.files.has(qtiPath) ? 'invalid' : 'unsupported');
      if (qti === 'limit') return set('transform');
      if (qti.local === 'assessmentTest' || qti.local === 'assessmentItem' || /imsqti_v2/i.test(qti.uri)) {
        issues.warn('CARTRIDGE_QTI_VERSION_UNSUPPORTED', { path: qtiPath, value: qti.uri || qti.local });
        return set('unsupported');
      }
      const assessment = [...walk(qti)].find((node) => node.local === 'assessment' || node.local === 'objectbank');
      resource.title ??= clean(assessment ? attr(assessment, 'title') : null, 200);
      const counts = new Map<string, QuestionTypeCount>();
      let questions = 0;
      for (const item of walk(qti)) {
        if (item.local !== 'item') continue;
        questions += 1;
        let profile: string | null = null;
        for (const field of walk(item)) {
          if (field.local !== 'qtimetadatafield') continue;
          const label = textOf(firstChild(field, 'fieldlabel')).toLowerCase();
          if (label === 'cc_profile' || (label === 'question_type' && !profile)) profile = textOf(firstChild(field, 'fieldentry'));
        }
        const known = profile ? QUESTION_TYPES[profile] : undefined;
        const key = known?.type ?? 'unknown';
        const entry = counts.get(key) ?? { type: key, count: 0, supported: known?.supported ?? false };
        entry.count += 1;
        counts.set(key, entry);
      }
      resource.questionCount = questions;
      resource.questionTypes = [...counts.values()];
      const unsupported = resource.questionTypes.filter((entry) => !entry.supported);
      if (resource.kind === 'question_bank') return set('unsupported');
      if (!questions) {
        issues.warn('CARTRIDGE_ASSESSMENT_EMPTY', { path: qtiPath });
        return set('unsupported');
      }
      if (unsupported.length) issues.warn('CARTRIDGE_QUESTION_TYPE_UNSUPPORTED', { path: qtiPath, value: unsupported.map((entry) => entry.type).join(', ') });
      return set(!unsupported.length ? 'mappable' : unsupported.length < resource.questionTypes.length ? 'transform' : 'unsupported');
    }
    case 'discussion': {
      const topic = primary ? readXml(archive, primary, issues) : null;
      if (topic === null) return set('invalid');
      if (topic !== 'limit') resource.title ??= clean(textOf(firstChild(topic, 'title')) || null, 200);
      return set('transform');
    }
    case 'web_link':
    case 'lti_link': {
      const link = primary ? readXml(archive, primary, issues) : null;
      if (link === null) return set('invalid');
      if (link === 'limit') return set(resource.kind === 'web_link' ? 'transform' : 'unsupported');
      resource.title ??= clean(descendantText(link, 'title'), 200);
      const url = resource.kind === 'web_link' ? attr(firstChild(link, 'url') ?? link, 'href') : (descendantText(link, 'secure_launch_url') ?? descendantText(link, 'launch_url'));
      resource.url = clean(url, 300);
      if (!url) {
        issues.error('CARTRIDGE_DESCRIPTOR_MALFORMED', { path: primary, value: 'url' });
        return set('invalid');
      }
      if (!/^https?:\/\//i.test(url)) {
        issues.error('CARTRIDGE_LINK_DANGEROUS', { path: primary, value: url.split(':')[0] ?? url });
        return set('invalid');
      }
      if (resource.kind === 'lti_link') return set('unsupported');
      if (/^http:\/\//i.test(url)) {
        issues.warn('CARTRIDGE_WEBLINK_INSECURE', { path: primary, value: url });
        return set('transform');
      }
      return set('mappable');
    }
    case 'assignment': {
      const settingsPath = resource.files.find((path) => path.endsWith('assignment_settings.xml')) ?? primary;
      const settings = settingsPath ? readXml(archive, settingsPath, issues) : null;
      if (settings === null) return set('invalid');
      if (settings !== 'limit') {
        resource.title ??= clean(textOf(firstChild(settings, 'title')) || null, 200);
        const canvasTypes = textOf(firstChild(settings, 'submission_types'));
        const ccTypes = childrenNamed(firstChild(settings, 'submission_formats'), 'format').map((format) => attr(format, 'type') ?? '');
        resource.submissionTypes = [...(canvasTypes ? canvasTypes.split(',') : []), ...ccTypes].map((value) => clean(value, 60)).filter((value): value is string => !!value).slice(0, 10);
      }
      return set('transform');
    }
    case 'canvas_settings':
      return set('recognized');
    case 'learning_application':
      // Canvas quiz settings, discussion settings and similar support files: recognized when another resource uses them.
      return set(resource.identifier && referenced.has(resource.identifier) ? 'recognized' : 'unsupported');
    default:
      return set('unsupported');
  }
}

/** HTML references, without rendering or fetching anything: local files that are missing, external and Canvas links. */
const REFERENCE = /\b(?:href|src)\s*=\s*(?:"([^"]{0,2048})"|'([^']{0,2048})')/gi;
const FILEBASE = /^\$IMS[-_]CC[-_]FILEBASE\$\/?/i;
const CANVAS_TOKEN = /^\$(WIKI_REFERENCE|CANVAS_OBJECT_REFERENCE|CANVAS_COURSE_REFERENCE)\$|^\/courses\/\d+\//i;

function scanPage(path: string, archive: ArchiveScan, resource: Resource, issues: CartridgeIssues) {
  const bytes = archive.kept.get(path);
  if (!bytes) {
    if (archive.files.has(path)) issues.warn('CARTRIDGE_DESCRIPTOR_LIMIT', { path, limit: CARTRIDGE_LIMITS.maxDescriptorBytes });
    return;
  }
  const html = bytes.toString('utf8');
  resource.title ??= clean(/<title[^>]*>([^<]{1,300})<\/title>/i.exec(html)?.[1] ?? null, 200);
  const dir = dirOf(path);
  const exists = (candidate: ReturnType<typeof resolveHref>) => candidate.kind === 'local' && archive.files.has(candidate.path);
  let reported = 0;
  let dangerous = false;
  for (const match of html.matchAll(REFERENCE)) {
    const ref = (match[1] ?? match[2] ?? '').replace(/&amp;/g, '&').trim();
    if (!ref || ref.startsWith('#')) continue;
    if (CANVAS_TOKEN.test(ref)) {
      resource.canvasLinks += 1;
      continue;
    }
    let broken = false;
    if (FILEBASE.test(ref)) {
      const rest = ref.replace(FILEBASE, '');
      broken = ![resolveHref(rest, ['web_resources']), resolveHref(rest, [dir]), resolveHref(rest)].some(exists);
    } else {
      const result = resolveHref(ref, [dir]);
      if (result.kind === 'external') {
        if (/^https?:/i.test(result.value)) resource.externalLinks += 1;
        continue;
      }
      if (result.kind === 'dangerous') {
        dangerous = true;
        continue;
      }
      broken = !exists(result);
    }
    if (broken) {
      resource.brokenLinks += 1;
      if (reported < CARTRIDGE_LIMITS.maxLinkIssuesPerPage) {
        issues.warn('CARTRIDGE_LINK_BROKEN', { path, value: ref });
        reported += 1;
      }
    }
  }
  if (dangerous) issues.warn('CARTRIDGE_LINK_DANGEROUS', { path });
}

function compatibility(moduleCount: number, nested: boolean, resources: Resource[]): CartridgeInspectionReport['compatibility'] {
  const rows = new Map<string, { kind: ResourceKind | 'module'; count: number; target: Target; support: Support }>();
  if (moduleCount) rows.set('module', { kind: 'module', count: moduleCount, target: 'section', support: nested ? 'transform' : 'direct' });
  for (const resource of resources) {
    if (resource.classification === 'invalid' || resource.classification === 'recognized') continue;
    const support: Support =
      resource.classification === 'mappable' ? 'direct' : resource.classification === 'transform' ? 'transform' : NEW_FUNCTIONALITY.has(resource.kind) ? 'new_functionality' : 'unsupported';
    const key = `${resource.kind}:${support}`;
    const row = rows.get(key) ?? { kind: resource.kind, count: 0, target: support === 'unsupported' ? null : resource.target, support };
    row.count += 1;
    rows.set(key, row);
  }
  return [...rows.values()];
}
