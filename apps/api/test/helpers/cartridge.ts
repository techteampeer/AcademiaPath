/**
 * AP-038D synthetic IMS Common Cartridge packages, generated in code (no Canvas export, private course or third-party
 * content). The Canvas-style package follows the folder and file conventions of Canvas course exports
 * (course_settings/, wiki_content/, web_resources/, non_cc_assessments/) with invented, neutral content. Every address
 * uses example.edu and is never fetched. Shared by the API and browser tests.
 */
import { buildZip, manifest12, type ZipSpec } from './scorm.js';

export type CartridgeVersionSpec = '1.0' | '1.1' | '1.2' | '1.3';
const NAMESPACES: Record<CartridgeVersionSpec, string> = {
  '1.0': 'http://www.imsglobal.org/xsd/imscc/imscp_v1p1',
  '1.1': 'http://www.imsglobal.org/xsd/imsccv1p1/imscp_v1p1',
  '1.2': 'http://www.imsglobal.org/xsd/imsccv1p2/imscp_v1p1',
  '1.3': 'http://www.imsglobal.org/xsd/imsccv1p3/imscp_v1p1',
};
const SUFFIX: Record<CartridgeVersionSpec, string> = { '1.0': 'v1p0', '1.1': 'v1p1', '1.2': 'v1p2', '1.3': 'v1p3' };

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const file = (name: string, data: string | Buffer, options: Partial<ZipSpec> = {}): ZipSpec => ({ name, data, method: 'deflate', ...options });

export type ItemSpec = { id: string; title: string; ref?: string; children?: ItemSpec[] };
export type ResourceSpec = { id: string; type: string; href?: string; files?: string[]; deps?: string[]; inline?: string };

export function ccManifest(options: {
  version?: CartridgeVersionSpec;
  /** Overrides (null removes the element or uses the version's default). */
  schema?: string | null;
  schemaVersion?: string | null;
  namespace?: string;
  title?: string;
  modules: ItemSpec[];
  resources: ResourceSpec[];
  canvas?: boolean;
  /** Raw text inserted before <manifest> (e.g. a DOCTYPE). */
  prolog?: string;
  rooted?: boolean;
}): string {
  const version = options.version ?? '1.1';
  const namespace = options.namespace ?? NAMESPACES[version];
  const schema = options.schema === undefined ? 'IMS Common Cartridge' : options.schema;
  const schemaVersion = options.schemaVersion === undefined ? `${version}.0` : options.schemaVersion;
  const item = (spec: ItemSpec): string =>
    `<item identifier="${spec.id}"${spec.ref ? ` identifierref="${spec.ref}"` : ''}><title>${esc(spec.title)}</title>${(spec.children ?? []).map(item).join('')}</item>`;
  const outline = options.modules.map(item).join('');
  const resource = (spec: ResourceSpec) =>
    `<resource identifier="${spec.id}" type="${spec.type}"${spec.href ? ` href="${esc(spec.href)}"` : ''}>${(spec.files ?? (spec.href ? [spec.href] : [])).map((href) => `<file href="${esc(href)}"/>`).join('')}${(spec.deps ?? []).map((dep) => `<dependency identifierref="${dep}"/>`).join('')}${spec.inline ?? ''}</resource>`;
  return `<?xml version="1.0" encoding="UTF-8"?>${options.prolog ?? ''}
<manifest identifier="cc_manifest" xmlns="${namespace}" xmlns:lomimscc="http://ltsc.ieee.org/xsd/imscc${version === '1.0' ? '' : SUFFIX[version]}/LOM/manifest"${options.canvas ? ' xmlns:canvas="http://canvas.instructure.com/xsd/cccv1p0"' : ''}>
  <metadata>${schema === null ? '' : `<schema>${esc(schema)}</schema>`}${schemaVersion === null ? '' : `<schemaversion>${esc(schemaVersion)}</schemaversion>`}
    <lomimscc:lom><lomimscc:general><lomimscc:title><lomimscc:string>${esc(options.title ?? 'Synthetic cartridge')}</lomimscc:string></lomimscc:title><lomimscc:description><lomimscc:string>Synthetic test package.</lomimscc:string></lomimscc:description><lomimscc:language>es</lomimscc:language></lomimscc:general></lomimscc:lom>
  </metadata>
  <organizations><organization identifier="org_1" structure="rooted-hierarchy">${options.rooted === false ? outline : `<item identifier="LearningModules">${outline}</item>`}</organization></organizations>
  <resources>${options.resources.map(resource).join('')}</resources>
</manifest>`;
}

export const html = (title: string, body = '<p>Synthetic page.</p>') => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;
export const qti = (title: string, profiles: string[], label: 'cc_profile' | 'question_type' = 'cc_profile') =>
  `<?xml version="1.0" encoding="UTF-8"?><questestinterop xmlns="http://www.imsglobal.org/xsd/ims_qtiasiv1p2"><assessment ident="a_${title.length}" title="${esc(title)}"><section ident="root_section">${profiles
    .map(
      (profile, index) =>
        `<item ident="q${index + 1}" title="Question ${index + 1}"><itemmetadata><qtimetadata><qtimetadatafield><fieldlabel>${label}</fieldlabel><fieldentry>${profile}</fieldentry></qtimetadatafield></qtimetadata></itemmetadata><presentation><material><mattext texttype="text/plain">Synthetic question ${index + 1}</mattext></material></presentation></item>`,
    )
    .join('')}</section></assessment></questestinterop>`;
const discussion = (title: string) => `<?xml version="1.0" encoding="UTF-8"?><topic xmlns="http://www.imsglobal.org/xsd/imsccv1p1/imsdt_v1p1"><title>${esc(title)}</title><text texttype="text/html">&lt;p&gt;Synthetic topic.&lt;/p&gt;</text></topic>`;
const webLink = (title: string, url: string) => `<?xml version="1.0" encoding="UTF-8"?><webLink xmlns="http://www.imsglobal.org/xsd/imsccv1p1/imswl_v1p1"><title>${esc(title)}</title><url href="${esc(url)}" target="_iframe"/></webLink>`;
const lti = (title: string, url: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0" xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0"><blti:title>${esc(title)}</blti:title><blti:launch_url>${esc(url)}</blti:launch_url></cartridge_basiclti_link>`;
const canvasXml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>${body.replace(/^<(\w+)/, '<$1 xmlns="http://canvas.instructure.com/xsd/cccv1p0"')}`;

/** A Canvas-style Common Cartridge 1.1 export with every resource kind the inspector recognizes. */
export function canvasCourse(): Buffer {
  const pageBody = [
    '<p>Synthetic page with references.</p>',
    '<img src="$IMS-CC-FILEBASE$/images/diagram.png" alt="Diagram">',
    '<a href="$IMS-CC-FILEBASE$/missing-handout.pdf">Missing handout</a>',
    '<a href="https://example.edu/reading">External reading</a>',
    '<a href="$WIKI_REFERENCE$/pages/unit-2-notes">Canvas page link</a>',
    '<a href="unit-2-notes.html">Relative page link</a>',
  ].join('');
  const resources: ResourceSpec[] = [
    { id: 'settings', type: 'associatedcontent/imscc_xmlv1p1/learning-application-resource', href: 'course_settings/canvas_export.txt', files: ['course_settings/canvas_export.txt', 'course_settings/course_settings.xml', 'course_settings/module_meta.xml', 'course_settings/assignment_groups.xml'] },
    { id: 'page1', type: 'webcontent', href: 'wiki_content/unit-1-welcome.html' },
    { id: 'page2', type: 'webcontent', href: 'wiki_content/unit-2-notes.html' },
    { id: 'pdf', type: 'webcontent', href: 'web_resources/syllabus.pdf' },
    { id: 'img', type: 'webcontent', href: 'web_resources/images/diagram.png' },
    { id: 'video', type: 'webcontent', href: 'web_resources/media/lecture.mp4' },
    { id: 'quiz1', type: 'imsqti_xmlv1p2/imscc_xmlv1p1/assessment', href: 'quiz1/assessment_qti.xml', deps: ['quiz1meta'] },
    { id: 'quiz1meta', type: 'associatedcontent/imscc_xmlv1p1/learning-application-resource', href: 'quiz1/assessment_meta.xml' },
    { id: 'quiz2', type: 'imsqti_xmlv1p2/imscc_xmlv1p1/assessment', href: 'quiz2/assessment_qti.xml' },
    { id: 'quiz3', type: 'associatedcontent/imscc_xmlv1p1/learning-application-resource', href: 'quiz3/assessment_meta.xml', files: ['quiz3/assessment_meta.xml', 'non_cc_assessments/quiz3.xml.qti'] },
    { id: 'bank', type: 'imsqti_xmlv1p2/imscc_xmlv1p1/question-bank', href: 'banks/bank1.xml' },
    { id: 'assign', type: 'associatedcontent/imscc_xmlv1p1/learning-application-resource', href: 'assign1/essay.html', files: ['assign1/essay.html', 'assign1/assignment_settings.xml'] },
    { id: 'topic', type: 'imsdt_xmlv1p1', href: 'topic1.xml' },
    { id: 'link', type: 'imswl_xmlv1p1', href: 'link1.xml' },
    { id: 'tool', type: 'imsbasiclti_xmlv1p0', href: 'tool1.xml' },
    { id: 'mystery', type: 'x-vendor/unknown-type', href: 'mystery.dat' },
  ];
  const modules: ItemSpec[] = [
    {
      id: 'm1',
      title: 'Unit 1 - Foundations',
      children: [
        { id: 'i1', title: 'Welcome', ref: 'page1' },
        { id: 'i2', title: 'Course syllabus', ref: 'pdf' },
        { id: 'i3', title: 'Readings', children: [{ id: 'i3a', title: 'Notes', ref: 'page2' }] },
        { id: 'i4', title: 'Check 1', ref: 'quiz1' },
        { id: 'i5', title: 'Lecture video', ref: 'video' },
      ],
    },
    {
      id: 'm2',
      title: 'Unit 2 - Practice',
      children: [
        { id: 'i6', title: 'Mixed check', ref: 'quiz2' },
        { id: 'i7', title: 'Written check', ref: 'quiz3' },
        { id: 'i8', title: 'Essay', ref: 'assign' },
        { id: 'i9', title: 'Introductions', ref: 'topic' },
        { id: 'i10', title: 'Reading list', ref: 'link' },
        { id: 'i11', title: 'External tool', ref: 'tool' },
        { id: 'i12', title: 'Section heading' },
      ],
    },
  ];
  return buildZip([
    file('imsmanifest.xml', ccManifest({ version: '1.1', title: 'Synthetic Canvas course', modules, resources, canvas: true })),
    file('course_settings/canvas_export.txt', 'Synthetic export marker.'),
    file('course_settings/course_settings.xml', canvasXml('<course identifier="c1"><title>Synthetic Canvas course</title></course>')),
    file('course_settings/module_meta.xml', canvasXml('<modules><module identifier="m1"><title>Unit 1 - Foundations</title></module></modules>')),
    file('course_settings/assignment_groups.xml', canvasXml('<assignmentGroups><assignmentGroup identifier="g1"><title>Assignments</title></assignmentGroup></assignmentGroups>')),
    file('wiki_content/unit-1-welcome.html', html('Welcome', pageBody)),
    file('wiki_content/unit-2-notes.html', html('Notes')),
    file('web_resources/syllabus.pdf', '%PDF-1.4 synthetic'),
    file('web_resources/images/diagram.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    file('web_resources/media/lecture.mp4', Buffer.alloc(64)),
    file('quiz1/assessment_qti.xml', qti('Check 1', ['cc.multiple_choice.v0p1', 'cc.true_false.v0p1', 'cc.multiple_response.v0p1'])),
    file('quiz1/assessment_meta.xml', canvasXml('<quiz identifier="quiz1"><title>Check 1</title></quiz>')),
    file('quiz2/assessment_qti.xml', qti('Mixed check', ['cc.multiple_choice.v0p1', 'cc.essay.v0p1', 'cc.fib.v0p1'])),
    file('quiz3/assessment_meta.xml', canvasXml('<quiz identifier="quiz3"><title>Written check</title></quiz>')),
    file('non_cc_assessments/quiz3.xml.qti', qti('Written check', ['essay_question', 'matching_question'], 'question_type')),
    file('banks/bank1.xml', qti('Bank', ['cc.true_false.v0p1', 'cc.true_false.v0p1'])),
    file('assign1/essay.html', html('Essay', '<p>Write 300 words.</p>')),
    file('assign1/assignment_settings.xml', canvasXml('<assignment identifier="assign"><title>Essay</title><submission_types>online_upload,online_text_entry</submission_types><points_possible>20</points_possible></assignment>')),
    file('topic1.xml', discussion('Introductions')),
    file('link1.xml', webLink('Reading list', 'https://example.edu/reading-list')),
    file('tool1.xml', lti('External tool', 'https://tool.example.edu/launch')),
    file('mystery.dat', 'vendor data'),
  ]);
}

/** A minimal, valid cartridge of the given version: one page, one https link, one PDF. */
export function minimalCartridge(version: CartridgeVersionSpec, overrides: Partial<Parameters<typeof ccManifest>[0]> = {}): Buffer {
  const s = SUFFIX[version];
  return buildZip([
    file(
      'imsmanifest.xml',
      ccManifest({
        version,
        title: `Cartridge ${version}`,
        modules: [{ id: 'm1', title: 'Module 1', children: [{ id: 'i1', title: 'Page', ref: 'r1' }, { id: 'i2', title: 'Link', ref: 'r2' }, { id: 'i3', title: 'Guide', ref: 'r3' }] }],
        resources: [
          { id: 'r1', type: 'webcontent', href: 'pages/page.html' },
          { id: 'r2', type: `imswl_xml${s}`, href: 'links/link.xml' },
          { id: 'r3', type: 'webcontent', href: 'files/guide.pdf' },
        ],
        ...overrides,
      }),
    ),
    file('pages/page.html', html('Page')),
    file('links/link.xml', webLink('Link', 'https://example.edu/page')),
    file('files/guide.pdf', '%PDF-1.4 synthetic'),
  ]);
}

/** Deterministic, incompressible text (a fixed-seed xorshift stream, base64): exercises size limits, not ratio checks. */
export function noise(bytes: number): string {
  let state = 0x2545f491;
  const out = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out.toString('base64');
}

const single = (manifest: string, extra: ZipSpec[] = []) => buildZip([file('imsmanifest.xml', manifest), file('pages/page.html', html('Page')), ...extra]);
const onePage = (overrides: Partial<Parameters<typeof ccManifest>[0]> = {}) =>
  ccManifest({ modules: [{ id: 'm1', title: 'Module', children: [{ id: 'i1', title: 'Page', ref: 'r1' }] }], resources: [{ id: 'r1', type: 'webcontent', href: 'pages/page.html' }], ...overrides });

export const CARTRIDGE_FIXTURES = {
  canvas: canvasCourse,
  cc10: () => minimalCartridge('1.0'),
  cc11: () => minimalCartridge('1.1'),
  cc12: () => minimalCartridge('1.2'),
  cc13: () => minimalCartridge('1.3'),
  thin: () =>
    buildZip([
      file(
        'imsmanifest.xml',
        ccManifest({
          version: '1.3',
          schema: 'IMS Thin Common Cartridge',
          modules: [{ id: 'm1', title: 'Links', children: [{ id: 'i1', title: 'Link', ref: 'r1' }, { id: 'i2', title: 'Tool', ref: 'r2' }] }],
          resources: [
            { id: 'r1', type: 'imswl_xmlv1p3', href: 'link.xml' },
            { id: 'r2', type: 'imsbasiclti_xmlv1p3', href: 'tool.xml' },
          ],
        }),
      ),
      file('link.xml', webLink('Link', 'https://example.edu/a')),
      file('tool.xml', lti('Tool', 'https://tool.example.edu/launch')),
    ]),
  unsupportedVersion: () => single(onePage({ schemaVersion: '1.4.0', namespace: 'http://www.imsglobal.org/xsd/imsccv1p4/imscp_v1p1' })),
  unknownNamespace: () => single(onePage({ schemaVersion: null, namespace: 'http://www.imsglobal.org/xsd/imsccv1p4/imscp_v1p1' })),
  undeclaredVersion: () => single(onePage({ version: '1.3', schemaVersion: null })),
  versionMismatch: () => single(onePage({ version: '1.1', schemaVersion: '1.2.0' })),
  scorm: () =>
    buildZip([
      file('imsmanifest.xml', manifest12({ items: [{ id: 'i1', title: 'Lesson', ref: 'sco1' }], resources: [{ id: 'sco1', title: 'Lesson', href: 'index.html', scormType: 'sco' }] })),
      file('index.html', html('Lesson')),
    ]),
  contentPackage: () => single(onePage({ schema: 'IMS Content', schemaVersion: '1.1.4', namespace: 'http://www.imsglobal.org/xsd/imscp_v1p1' })),
  missingManifest: () => buildZip([file('pages/page.html', html('Page'))]),
  nestedManifest: () => buildZip([file('course/imsmanifest.xml', onePage()), file('course/pages/page.html', html('Page'))]),
  malformedManifest: () => buildZip([file('imsmanifest.xml', '<manifest><resources><resource></manifest>')]),
  doctypeManifest: () => single(onePage({ prolog: '<!DOCTYPE manifest [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' })),
  empty: () => buildZip([]),
  notZip: () => Buffer.from('Plain text that only pretends to be a cartridge.'),
  truncated: () => minimalCartridge('1.1').subarray(0, 120),
  traversal: () => single(onePage(), [file('../../evil.html', html('Evil'))]),
  absolutePath: () => single(onePage(), [file('/etc/cron.d/job', 'x')]),
  duplicatePaths: () => single(onePage(), [file('pages/page.html', html('Other'))]),
  symlink: () => single(onePage(), [file('pages/link.html', '/etc/passwd', { method: 'store', unixMode: 0o120777 })]),
  zipBomb: () => single(onePage(), [file('web_resources/zeros.bin', Buffer.alloc(4 * 1024 * 1024))]),
  tooManyEntries: () => buildZip([file('imsmanifest.xml', onePage()), ...Array.from({ length: 10_001 }, (_, n) => file(`f/${n}.txt`, ''))]),
  missingResource: () => buildZip([file('imsmanifest.xml', onePage())]),
  brokenReferences: () =>
    single(
      ccManifest({
        modules: [{ id: 'm1', title: 'Module', children: [{ id: 'i1', title: 'Page', ref: 'r1' }, { id: 'i2', title: 'Ghost', ref: 'nothing' }] }],
        resources: [
          { id: 'r1', type: 'webcontent', href: 'pages/page.html', deps: ['absent'] },
          { id: 'r1', type: 'webcontent', href: 'pages/page.html' },
          { id: 'r2', type: 'webcontent', href: '../outside.html' },
          { id: 'r3', type: 'webcontent', href: 'javascript:alert(1)' },
          { id: 'r4', type: 'webcontent', href: 'https://example.edu/hosted.html' },
        ],
      }),
    ),
  unsafeDescriptors: () =>
    buildZip([
      file(
        'imsmanifest.xml',
        ccManifest({
          modules: [{ id: 'm1', title: 'Module', children: [{ id: 'i1', title: 'Quiz', ref: 'q1' }, { id: 'i2', title: 'Plain link', ref: 'l1' }, { id: 'i3', title: 'Script link', ref: 'l2' }, { id: 'i4', title: 'QTI 2', ref: 'q2' }] }],
          resources: [
            { id: 'q1', type: 'imsqti_xmlv1p2/imscc_xmlv1p1/assessment', href: 'q1.xml' },
            { id: 'l1', type: 'imswl_xmlv1p1', href: 'l1.xml' },
            { id: 'l2', type: 'imswl_xmlv1p1', href: 'l2.xml' },
            { id: 'q2', type: 'imsqti_xmlv1p2/imscc_xmlv1p1/assessment', href: 'q2.xml' },
          ],
        }),
      ),
      file('q1.xml', `<?xml version="1.0"?><!DOCTYPE q [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><questestinterop>&b;</questestinterop>`),
      file('l1.xml', webLink('Plain link', 'http://example.edu/insecure')),
      file('l2.xml', webLink('Script link', 'javascript:alert(document.cookie)')),
      file('q2.xml', '<?xml version="1.0"?><assessmentTest xmlns="http://www.imsglobal.org/xsd/imsqti_v2p1" identifier="t" title="QTI 2 test"/>'),
    ]),
  manyResources: () =>
    buildZip([
      file(
        'imsmanifest.xml',
        ccManifest({
          modules: [{ id: 'm1', title: 'Files', children: Array.from({ length: 520 }, (_, n) => ({ id: `i${n}`, title: `File ${n}`, ref: `r${n}` })) }],
          resources: Array.from({ length: 520 }, (_, n) => ({ id: `r${n}`, type: 'webcontent', href: `files/f${n}.pdf` })),
        }),
      ),
      ...Array.from({ length: 520 }, (_, n) => file(`files/f${n}.pdf`, '%PDF-1.4')),
    ]),
  oversizedPage: () =>
    single(onePage({ resources: [{ id: 'r1', type: 'webcontent', href: 'pages/big.html' }] }), [file('pages/big.html', html('Big', `<p>${noise(800 * 1024)}</p>`))]),
};
export type CartridgeFixture = keyof typeof CARTRIDGE_FIXTURES;
