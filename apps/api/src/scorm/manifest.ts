import { SaxesParser, type SaxesTagNS } from 'saxes';
import type { ArchiveScan } from './archive.js';
import { SCORM_LIMITS } from './limits.js';
import { collisionKey, resolveHref, type HrefResult } from './paths.js';
import { clean, type IssueList, type ScormEdition, type ScormInspectionReport, type ScormIssueSeverity, type ScormVersion } from './report.js';

/**
 * AP-033B: strict, bounded parsing and structural analysis of imsmanifest.xml. The XML is parsed without a DTD:
 * a DOCTYPE is refused, so no entity is declared or expanded and nothing external is ever fetched.
 */
export type XmlNode = {
  uri: string;
  local: string;
  attributes: Array<{ uri: string; local: string; value: string }>;
  children: XmlNode[];
  text: string;
  line: number;
};

const NS = {
  cp12: 'http://www.imsproject.org/xsd/imscp_rootv1p1p2',
  cp2004: 'http://www.imsglobal.org/xsd/imscp_v1p1',
  adlcp12: 'http://www.adlnet.org/xsd/adlcp_rootv1p2',
  adlcp2004: 'http://www.adlnet.org/xsd/adlcp_v1p3',
  imsss: 'http://www.imsglobal.org/xsd/imsss',
  adlseq: 'http://www.adlnet.org/xsd/adlseq_v1p3',
  xml: 'http://www.w3.org/XML/1998/namespace',
} as const;
const COMMON_CARTRIDGE = /imscc/i;
const ADLCP = new Set<string>([NS.adlcp12, NS.adlcp2004]);

class ManifestFailure extends Error {
  constructor(
    readonly code: 'SCORM_MANIFEST_MALFORMED' | 'SCORM_MANIFEST_DOCTYPE' | 'SCORM_MANIFEST_TOO_DEEP' | 'SCORM_MANIFEST_TOO_MANY_ELEMENTS',
    readonly line: number | null,
    readonly limit: number | null = null,
  ) {
    super(code);
  }
}

/** Decodes the manifest bytes: a byte-order mark or the XML declaration chooses UTF-8, UTF-16 or Windows-1252. */
export function decodeManifest(bytes: Buffer): string | null {
  try {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3));
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    const declared = /^<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(bytes.subarray(0, 200).toString('latin1'))?.[1]?.toLowerCase();
    if (!declared || declared === 'utf-8' || declared === 'utf8' || declared === 'us-ascii' || declared === 'ascii') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (['iso-8859-1', 'latin1', 'latin-1', 'windows-1252', 'cp1252'].includes(declared)) return new TextDecoder('windows-1252').decode(bytes);
    return null;
  } catch {
    return null;
  }
}

/** Parses the manifest into a bounded element tree. */
export function parseManifestXml(xml: string): XmlNode {
  const parser = new SaxesParser({ xmlns: true, position: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let elements = 0;
  let failure: ManifestFailure | null = null;
  const fail = (error: ManifestFailure) => {
    failure ??= error;
    throw error;
  };
  parser.on('error', () => fail(new ManifestFailure('SCORM_MANIFEST_MALFORMED', parser.line)));
  parser.on('doctype', () => fail(new ManifestFailure('SCORM_MANIFEST_DOCTYPE', parser.line)));
  parser.on('opentag', (tag: SaxesTagNS) => {
    elements += 1;
    if (elements > SCORM_LIMITS.maxXmlElements) fail(new ManifestFailure('SCORM_MANIFEST_TOO_MANY_ELEMENTS', parser.line, SCORM_LIMITS.maxXmlElements));
    if (stack.length + 1 > SCORM_LIMITS.maxXmlDepth) fail(new ManifestFailure('SCORM_MANIFEST_TOO_DEEP', parser.line, SCORM_LIMITS.maxXmlDepth));
    const attributes = Object.values(tag.attributes);
    if (attributes.length > SCORM_LIMITS.maxXmlAttributes) fail(new ManifestFailure('SCORM_MANIFEST_TOO_MANY_ELEMENTS', parser.line, SCORM_LIMITS.maxXmlAttributes));
    const node: XmlNode = {
      uri: tag.uri,
      local: tag.local,
      attributes: attributes.map((attribute) => ({ uri: attribute.uri, local: attribute.local, value: attribute.value })),
      children: [],
      text: '',
      line: parser.line,
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else root ??= node;
    stack.push(node);
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  const appendText = (text: string) => {
    const node = stack.at(-1);
    if (node && node.text.length < SCORM_LIMITS.maxXmlText) node.text = (node.text + text).slice(0, SCORM_LIMITS.maxXmlText);
  };
  parser.on('text', appendText);
  parser.on('cdata', appendText);
  try {
    parser.write(xml).close();
  } catch (error) {
    throw failure ?? (error instanceof ManifestFailure ? error : new ManifestFailure('SCORM_MANIFEST_MALFORMED', parser.line));
  }
  if (failure) throw failure;
  if (!root) throw new ManifestFailure('SCORM_MANIFEST_MALFORMED', null);
  return root;
}

const attr = (node: XmlNode, local: string, uri = '') => node.attributes.find((attribute) => attribute.local === local && attribute.uri === uri)?.value ?? null;
const xmlBase = (node: XmlNode | undefined) => (node ? attr(node, 'base', NS.xml) : null);
const childrenNamed = (node: XmlNode | undefined, local: string) => node?.children.filter((child) => child.local === local) ?? [];
const firstChild = (node: XmlNode | undefined, local: string) => node?.children.find((child) => child.local === local);
const textOf = (node: XmlNode | undefined) => (node ? node.text.trim() : '');

function* walk(node: XmlNode): Generator<XmlNode> {
  const stack = [node];
  while (stack.length) {
    const current = stack.pop()!;
    yield current;
    for (let index = current.children.length - 1; index >= 0; index -= 1) stack.push(current.children[index]!);
  }
}

/** The LOM general title (SCORM 2004 <string>, SCORM 1.2 <langstring>), when the metadata is inline. */
function lomTitle(metadata: XmlNode | undefined): string | null {
  if (!metadata) return null;
  for (const node of walk(metadata)) {
    if (node.local !== 'general') continue;
    const title = firstChild(node, 'title');
    const text = title ? (firstChild(title, 'string') ?? firstChild(title, 'langstring')) : undefined;
    const value = clean(textOf(text));
    if (value) return value;
  }
  return null;
}

type Detected = { format: 'scorm' | 'common_cartridge' | 'unknown'; version: ScormVersion | null; edition: ScormEdition | null; schemaVersion: string | null; supported: boolean };

function detectStandard(root: XmlNode, issues: IssueList): Detected {
  const metadata = firstChild(root, 'metadata');
  const schema = textOf(firstChild(metadata, 'schema'));
  const declared = textOf(firstChild(metadata, 'schemaversion'));
  const schemaVersion = clean(declared, 60);
  const uris = new Set<string>();
  for (const node of walk(root)) {
    uris.add(node.uri);
    for (const attribute of node.attributes) uris.add(attribute.uri);
  }
  if ([...uris].some((uri) => COMMON_CARTRIDGE.test(uri)) || /common cartridge/i.test(schema)) {
    issues.error('SCORM_COMMON_CARTRIDGE', { value: schemaVersion });
    return { format: 'common_cartridge', version: null, edition: null, schemaVersion, supported: false };
  }
  if (root.uri !== NS.cp12 && root.uri !== NS.cp2004) issues.warning('SCORM_MANIFEST_NAMESPACE_UNKNOWN', { value: root.uri || null, line: root.line });

  let version: ScormVersion | null = null;
  let edition: ScormEdition | null = null;
  const value = declared.toLowerCase().replace(/\s+/g, ' ');
  if (value === '1.2') version = 'scorm_1_2';
  else if (value === 'cam 1.3' || /^2004 2nd edition$/.test(value)) [version, edition] = ['scorm_2004', '2nd'];
  else if (/^2004 3rd edition$/.test(value)) [version, edition] = ['scorm_2004', '3rd'];
  else if (/^2004 4th edition$/.test(value)) [version, edition] = ['scorm_2004', '4th'];
  else if (value) {
    issues.error('SCORM_VERSION_UNSUPPORTED', { value: schemaVersion });
    return { format: 'scorm', version: null, edition: null, schemaVersion, supported: false };
  }

  const uses12 = uris.has(NS.adlcp12) || root.uri === NS.cp12;
  const uses2004 = uris.has(NS.adlcp2004) || uris.has(NS.imsss) || uris.has(NS.adlseq);
  if (!version) {
    if (uses12 && !uses2004) version = 'scorm_1_2';
    else if (uses2004 && !uses12) version = 'scorm_2004';
    if (!version) {
      issues.error('SCORM_VERSION_UNKNOWN');
      return { format: 'unknown', version: null, edition: null, schemaVersion, supported: false };
    }
    issues.warning('SCORM_VERSION_INFERRED');
  } else if ((version === 'scorm_1_2' && uses2004) || (version === 'scorm_2004' && uris.has(NS.adlcp12))) {
    issues.warning('SCORM_VERSION_MISMATCH', { value: schemaVersion });
  }
  if (declared && schema.toLowerCase() !== 'adl scorm') issues.warning('SCORM_METADATA_SCHEMA_UNEXPECTED', { value: clean(schema, 60) });
  return { format: 'scorm', version, edition, schemaVersion, supported: true };
}

type ResourceInfo = {
  identifier: string;
  scormType: 'sco' | 'asset';
  launch: HrefResult | null;
  launchPath: string | null;
  fileCount: number;
  missingFileCount: number;
  dependencyCount: number;
  rawHref: string | null;
  line: number;
};

export type ManifestAnalysis = Pick<
  ScormInspectionReport,
  'standard' | 'title' | 'manifestIdentifier' | 'counts' | 'organizations' | 'launchable' | 'resources' | 'features' | 'listsTruncated'
> & { supported: boolean };

const isHtml = (path: string) => /\.(html?|xhtml?|xht)$/i.test(path);

export function analyzeManifest(root: XmlNode, archive: ArchiveScan, issues: IssueList): ManifestAnalysis {
  const analysis: ManifestAnalysis = {
    standard: { format: 'unknown', version: null, edition: null, schemaVersion: null },
    title: null,
    manifestIdentifier: null,
    counts: { organizations: 0, items: 0, resources: 0, scos: 0, assets: 0, launchable: 0, declaredFiles: 0, missingFiles: 0, undeclaredFiles: archive.fileCount },
    organizations: [],
    launchable: [],
    resources: [],
    features: { sequencing: false, subManifests: false },
    listsTruncated: false,
    supported: false,
  };
  if (root.local !== 'manifest') {
    issues.error('SCORM_MANIFEST_NOT_A_MANIFEST', { line: root.line });
    return analysis;
  }
  const detected = detectStandard(root, issues);
  analysis.standard = { format: detected.format, version: detected.version, edition: detected.edition, schemaVersion: detected.schemaVersion };
  analysis.supported = detected.supported;
  analysis.manifestIdentifier = clean(attr(root, 'identifier'), 200);
  if (detected.format === 'common_cartridge') return analysis;

  for (const node of walk(root)) {
    if (node.uri === NS.imsss || node.uri === NS.adlseq) analysis.features.sequencing = true;
    if (node !== root && node.local === 'manifest') analysis.features.subManifests = true;
  }
  if (analysis.features.sequencing) issues.warning('SCORM_SEQUENCING_IGNORED');
  if (analysis.features.subManifests) issues.warning('SCORM_SUBMANIFEST_UNSUPPORTED');

  // XML identifiers (organizations, items, resources) share one namespace and must be unique.
  const seen = new Set<string>();
  const identify = (node: XmlNode): string | null => {
    const id = attr(node, 'identifier')?.trim() || null;
    if (!id) {
      issues.error('SCORM_IDENTIFIER_MISSING', { line: node.line, value: node.local });
      return null;
    }
    if (seen.has(id)) issues.error('SCORM_IDENTIFIER_DUPLICATE', { line: node.line, value: id });
    seen.add(id);
    return id;
  };

  // Resources.
  const resourcesNode = firstChild(root, 'resources');
  const bases = [xmlBase(root), xmlBase(resourcesNode)];
  const resources = new Map<string, ResourceInfo>();
  const referencedFiles = new Set<string>();
  const dependencyRefs: Array<{ ref: string; line: number }> = [];
  const lookup = (path: string) => (archive.files.has(path) ? 'present' : archive.byKey.has(collisionKey(path)) ? 'case' : 'missing');

  for (const node of childrenNamed(resourcesNode, 'resource')) {
    const identifier = identify(node);
    const typeValue = node.attributes.find((attribute) => ADLCP.has(attribute.uri) && attribute.local.toLowerCase() === 'scormtype')?.value.trim().toLowerCase();
    let scormType: 'sco' | 'asset' = 'asset';
    if (typeValue === 'sco' || typeValue === 'asset') scormType = typeValue;
    else if (typeValue === undefined) issues.warning('SCORM_SCORMTYPE_MISSING', { line: node.line, value: identifier });
    else issues.warning('SCORM_SCORMTYPE_INVALID', { line: node.line, value: typeValue });
    const type = attr(node, 'type');
    if (type !== 'webcontent') issues.warning('SCORM_RESOURCE_TYPE_UNSUPPORTED', { line: node.line, value: type });

    const resourceBases = [...bases, xmlBase(node)];
    const rawHref = attr(node, 'href');
    const launch = rawHref === null ? null : resolveHref(rawHref, resourceBases);
    if (launch?.kind === 'local') referencedFiles.add(launch.path);

    let fileCount = 0;
    let missingFileCount = 0;
    for (const file of childrenNamed(node, 'file')) {
      fileCount += 1;
      const href = attr(file, 'href');
      if (href === null) {
        issues.error('SCORM_HREF_INVALID', { line: file.line });
        continue;
      }
      const resolved = resolveHref(href, resourceBases);
      reportHref(resolved, href, file.line, 'warning', issues);
      if (resolved.kind !== 'local') continue;
      referencedFiles.add(resolved.path);
      const state = lookup(resolved.path);
      if (state !== 'present') {
        missingFileCount += 1;
        // The launch file is reported once, by the launch check below.
        const isLaunchFile = launch?.kind === 'local' && launch.path === resolved.path;
        if (!isLaunchFile) issues.warning(state === 'case' ? 'SCORM_FILE_CASE_MISMATCH' : 'SCORM_FILE_MISSING', { path: resolved.path, line: file.line });
      }
    }
    let dependencyCount = 0;
    for (const dependency of childrenNamed(node, 'dependency')) {
      dependencyCount += 1;
      dependencyRefs.push({ ref: attr(dependency, 'identifierref')?.trim() ?? '', line: dependency.line });
    }
    analysis.counts.declaredFiles += fileCount;
    analysis.counts.missingFiles += missingFileCount;
    if (scormType === 'sco') analysis.counts.scos += 1;
    else analysis.counts.assets += 1;
    if (identifier && !resources.has(identifier)) {
      resources.set(identifier, { identifier, scormType, launch, launchPath: launch?.kind === 'local' ? launch.path : null, fileCount, missingFileCount, dependencyCount, rawHref, line: node.line });
    }
  }
  analysis.counts.resources = childrenNamed(resourcesNode, 'resource').length;
  for (const { ref, line } of dependencyRefs) {
    if (!resources.has(ref)) issues.error('SCORM_DEPENDENCY_INVALID', { line, value: ref || null });
  }

  // Organizations and items.
  const organizationsNode = firstChild(root, 'organizations');
  const organizations = childrenNamed(organizationsNode, 'organization');
  analysis.counts.organizations = organizations.length;
  const defaultId = attr(organizationsNode ?? root, 'default')?.trim() || null;
  const organizationIds = organizations.map((organization) => attr(organization, 'identifier')?.trim() ?? '');
  let defaultIndex = 0;
  if (!organizations.length) {
    issues.error('SCORM_NO_ORGANIZATIONS');
  } else if (defaultId === null) {
    issues.warning('SCORM_DEFAULT_ORGANIZATION_MISSING');
  } else if (!organizationIds.includes(defaultId)) {
    issues.error('SCORM_DEFAULT_ORGANIZATION_INVALID', { value: defaultId, line: organizationsNode?.line ?? null });
  } else {
    defaultIndex = organizationIds.indexOf(defaultId);
  }

  const referencedResources = new Map<string, number>();
  const launchable: ManifestAnalysis['launchable'] = [];
  const ordered = organizations.map((node, index) => ({ node, index })).sort((a, b) => Number(b.index === defaultIndex) - Number(a.index === defaultIndex));
  const listedOrganizations: ManifestAnalysis['organizations'] = [];

  for (const { node, index } of ordered) {
    const organizationId = identify(node) ?? '';
    let itemCount = 0;
    const visit = (parent: XmlNode, inheritedVisible: boolean) => {
      for (const item of childrenNamed(parent, 'item')) {
        itemCount += 1;
        const itemId = identify(item) ?? '';
        const ref = attr(item, 'identifierref')?.trim() || null;
        const visible = inheritedVisible && attr(item, 'isvisible')?.trim().toLowerCase() !== 'false';
        const children = childrenNamed(item, 'item');
        if (ref) {
          const resource = resources.get(ref);
          if (!resource) {
            issues.error('SCORM_ITEM_REFERENCE_INVALID', { line: item.line, value: ref });
          } else {
            referencedResources.set(ref, (referencedResources.get(ref) ?? 0) + 1);
            if (resource.launch?.kind === 'local' && lookup(resource.launch.path) === 'present') {
              launchable.push({
                organization: clean(organizationId, 200) ?? '',
                item: clean(itemId, 200) ?? '',
                title: clean(textOf(firstChild(item, 'title'))),
                resource: clean(resource.identifier, 200) ?? '',
                scormType: resource.scormType,
                launchPath: clean(resource.launch.path, 512) ?? '',
                parameters: clean(attr(item, 'parameters'), 300),
                visible,
              });
            }
          }
        } else if (!children.length) {
          issues.warning('SCORM_ITEM_WITHOUT_RESOURCE', { line: item.line, value: itemId || null });
        }
        visit(item, visible);
      }
    };
    visit(node, true);
    analysis.counts.items += itemCount;
    listedOrganizations.push({ identifier: clean(organizationId, 200) ?? '', title: clean(textOf(firstChild(node, 'title'))), isDefault: index === defaultIndex, itemCount });
  }

  // Launch files of resources that items refer to (each resource reported once).
  for (const resource of resources.values()) {
    const referenced = referencedResources.has(resource.identifier);
    if (resource.launch === null) {
      if (referenced) issues.error('SCORM_LAUNCH_HREF_MISSING', { line: resource.line, value: resource.identifier });
      continue;
    }
    reportHref(resource.launch, resource.rawHref ?? '', resource.line, referenced ? 'error' : 'warning', issues);
    if (resource.launch.kind !== 'local') continue;
    const state = lookup(resource.launch.path);
    if (state !== 'present') {
      if (referenced) issues.error(state === 'case' ? 'SCORM_FILE_CASE_MISMATCH' : 'SCORM_LAUNCH_FILE_MISSING', { path: resource.launch.path, line: resource.line });
      else issues.warning(state === 'case' ? 'SCORM_FILE_CASE_MISMATCH' : 'SCORM_FILE_MISSING', { path: resource.launch.path, line: resource.line });
    } else if (referenced) {
      if (/\.swf$/i.test(resource.launch.path)) issues.warning('SCORM_LAUNCH_FLASH', { path: resource.launch.path });
      else if (!isHtml(resource.launch.path)) issues.warning('SCORM_LAUNCH_NOT_HTML', { path: resource.launch.path });
    }
  }

  analysis.counts.launchable = launchable.length;
  if (organizations.length && !launchable.length) issues.error('SCORM_NO_LAUNCHABLE_CONTENT');
  const defaultOrganization = organizations[defaultIndex];
  analysis.title = clean(textOf(firstChild(defaultOrganization, 'title'))) ?? lomTitle(firstChild(root, 'metadata'));

  referencedFiles.add('imsmanifest.xml');
  analysis.counts.undeclaredFiles = [...archive.files.keys()].filter((path) => !referencedFiles.has(path)).length;

  const max = SCORM_LIMITS.maxListed;
  analysis.listsTruncated = listedOrganizations.length > max || launchable.length > max || resources.size > max;
  analysis.organizations = listedOrganizations.slice(0, max);
  analysis.launchable = launchable.slice(0, max);
  analysis.resources = [...resources.values()].slice(0, max).map((resource) => ({
    identifier: clean(resource.identifier, 200) ?? '',
    scormType: resource.scormType,
    launchPath: clean(resource.launchPath, 512),
    fileCount: resource.fileCount,
    missingFileCount: resource.missingFileCount,
    dependencyCount: resource.dependencyCount,
  }));
  return analysis;
}

/** Reports a non-local or unusable address. Dangerous, invalid and escaping addresses are always errors. */
function reportHref(result: HrefResult, raw: string, line: number, severity: ScormIssueSeverity, issues: IssueList) {
  if (result.kind === 'dangerous') issues.error('SCORM_HREF_DANGEROUS', { line, value: result.scheme });
  else if (result.kind === 'invalid') issues.error('SCORM_HREF_INVALID', { line, path: raw });
  else if (result.kind === 'outside') issues.error('SCORM_HREF_OUTSIDE_PACKAGE', { line, path: raw });
  else if (result.kind === 'external') issues.add('SCORM_HREF_EXTERNAL', severity, { line, path: result.value });
  else if (result.backslash) issues.warning('SCORM_HREF_BACKSLASH', { line, path: raw });
}

export { ManifestFailure };
