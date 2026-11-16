/**
 * AP-033B synthetic SCORM packages, generated in code (no third-party course content). The ZIP writer can produce
 * hostile archives — raw entry names, Unix symlink modes, encryption flags, forged sizes and checksums, duplicates —
 * that ordinary ZIP tools refuse to create. Shared by the API, CLI and browser tests.
 */
import { randomBytes } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

export type ZipSpec = {
  name: string | Buffer;
  data?: Buffer | string;
  method?: 'store' | 'deflate';
  /** Marks the name as UTF-8 (general purpose bit 11). Default true. */
  utf8?: boolean;
  /** Sets the "encrypted" flag (the data itself is not encrypted). */
  encrypted?: boolean;
  /** Unix mode written to the external attributes, with "made by" Unix (e.g. 0o120777 for a symlink). */
  unixMode?: number;
  /** Forged decompressed size written to both headers. */
  declaredSize?: number;
  /** Forged CRC-32 written to both headers. */
  crc?: number;
};

export function buildZip(entries: ZipSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = typeof entry.name === 'string' ? Buffer.from(entry.name, 'utf8') : entry.name;
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : (entry.data ?? Buffer.alloc(0));
    const method = entry.method ?? (raw.length > 0 ? 'deflate' : 'store');
    const data = method === 'deflate' ? deflateRawSync(raw) : raw;
    const flags = (entry.utf8 === false ? 0 : 0x800) | (entry.encrypted ? 0x1 : 0);
    const size = entry.declaredSize ?? raw.length;
    const checksum = entry.crc ?? crc32(raw);
    const methodCode = method === 'deflate' ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(methodCode, 8);
    local.writeUInt32LE(checksum >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(methodCode, 10);
    central.writeUInt32LE(checksum >>> 0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.unixMode === undefined ? 0 : (entry.unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const html = (title: string) => `<!doctype html><html><head><title>${title}</title><script>window.parent.API && window.parent.API.LMSInitialize('');</script></head><body><h1>${title}</h1></body></html>`;

type Sco = { id: string; title: string; href: string | null; scormType?: string | null; files?: string[]; dependencies?: string[]; extraAttributes?: string };
type Item = { id: string; title: string; ref?: string | null; children?: Item[]; visible?: boolean; parameters?: string };

const itemXml = (item: Item): string =>
  `<item identifier="${item.id}"${item.ref ? ` identifierref="${item.ref}"` : ''}${item.visible === false ? ' isvisible="false"' : ''}${item.parameters ? ` parameters="${item.parameters}"` : ''}><title>${item.title}</title>${(item.children ?? []).map(itemXml).join('')}</item>`;

/** A SCORM 1.2 manifest (IMS CP 1.1.2, adlcp_rootv1p2). */
export function manifest12(options: { title?: string; items: Item[]; resources: Sco[]; schemaVersion?: string | null; defaultOrg?: string | null; metadataExtra?: string; prefix?: string }) {
  const version = options.schemaVersion === null ? '' : `<schemaversion>${options.schemaVersion ?? '1.2'}</schemaversion>`;
  const resources = options.resources
    .map(
      (resource) =>
        `<resource identifier="${resource.id}" type="webcontent"${resource.scormType === null ? '' : ` adlcp:scormtype="${resource.scormType ?? 'sco'}"`}${resource.href === null ? '' : ` href="${resource.href}"`}${resource.extraAttributes ?? ''}>${(resource.files ?? (resource.href ? [resource.href] : [])).map((file) => `<file href="${file}"/>`).join('')}${(resource.dependencies ?? []).map((dep) => `<dependency identifierref="${dep}"/>`).join('')}</resource>`,
    )
    .join('');
  return `${options.prefix ?? '<?xml version="1.0" encoding="UTF-8"?>'}<manifest identifier="com.example.course" version="1.0" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"><metadata><schema>ADL SCORM</schema>${version}${options.metadataExtra ?? ''}</metadata><organizations${options.defaultOrg === null ? '' : ` default="${options.defaultOrg ?? 'ORG-1'}"`}><organization identifier="ORG-1"><title>${options.title ?? 'Synthetic SCORM 1.2 course'}</title>${options.items.map(itemXml).join('')}</organization></organizations><resources>${resources}</resources></manifest>`;
}

/** A SCORM 2004 manifest (IMS CP 1.1.4, adlcp_v1p3), optionally with IMS Simple Sequencing. */
export function manifest2004(options: { title?: string; items: Item[]; resources: Sco[]; schemaVersion?: string; sequencing?: boolean }) {
  const sequencing = options.sequencing ? '<imsss:sequencing><imsss:controlMode choice="true" flow="true"/></imsss:sequencing>' : '';
  const resources = options.resources
    .map(
      (resource) =>
        `<resource identifier="${resource.id}" type="webcontent" adlcp:scormType="${resource.scormType ?? 'sco'}"${resource.href === null ? '' : ` href="${resource.href}"`}>${(resource.files ?? (resource.href ? [resource.href] : [])).map((file) => `<file href="${file}"/>`).join('')}${(resource.dependencies ?? []).map((dep) => `<dependency identifierref="${dep}"/>`).join('')}</resource>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><manifest identifier="com.example.course2004" version="1" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3" xmlns:adlseq="http://www.adlnet.org/xsd/adlseq_v1p3" xmlns:adlnav="http://www.adlnet.org/xsd/adlnav_v1p3" xmlns:imsss="http://www.imsglobal.org/xsd/imsss"><metadata><schema>ADL SCORM</schema><schemaversion>${options.schemaVersion ?? '2004 4th Edition'}</schemaversion></metadata><organizations default="ORG-1"><organization identifier="ORG-1"><title>${options.title ?? 'Synthetic SCORM 2004 course'}</title>${options.items.map(itemXml).join('')}${sequencing}</organization></organizations><resources>${resources}</resources></manifest>`;
}

const single12 = () =>
  manifest12({
    title: 'Introduction to Service Management',
    items: [{ id: 'ITEM-1', title: 'Lesson 1: What is a service?', ref: 'RES-1' }],
    resources: [{ id: 'RES-1', title: '', href: 'index.html', files: ['index.html', 'shared/style.css'] }],
  });

const multi12 = () =>
  manifest12({
    title: 'Project Management Basics',
    items: [
      {
        id: 'MODULE-1',
        title: 'Module 1',
        children: [
          { id: 'ITEM-1', title: 'Lesson 1: Project charter', ref: 'SCO-1' },
          { id: 'ITEM-2', title: 'Lesson 2: Stakeholders', ref: 'SCO-2', parameters: '?section=2' },
        ],
      },
      { id: 'ITEM-3', title: 'Final quiz', ref: 'SCO-3' },
    ],
    resources: [
      { id: 'SCO-1', title: '', href: 'lessons/lesson1.html', dependencies: ['SHARED'] },
      { id: 'SCO-2', title: '', href: 'lessons/lesson2.html', dependencies: ['SHARED'] },
      { id: 'SCO-3', title: '', href: 'quiz/quiz.html', dependencies: ['SHARED'] },
      { id: 'SHARED', title: '', href: null, scormType: 'asset', files: ['shared/api.js', 'shared/logo.svg'] },
    ],
  });

const scorm2004 = (sequencing = false) =>
  manifest2004({
    title: 'Data Ethics',
    sequencing,
    items: [
      { id: 'ITEM-1', title: 'Privacy by design', ref: 'SCO-1' },
      { id: 'ITEM-2', title: 'Responsible data use', ref: 'SCO-2' },
    ],
    resources: [
      { id: 'SCO-1', title: '', href: 'content/privacy.html', files: ['content/privacy.html', 'content/common.js'] },
      { id: 'SCO-2', title: '', href: 'content/use.html', files: ['content/use.html', 'content/common.js'] },
    ],
  });

const file = (name: string, data: string | Buffer, extra: Partial<ZipSpec> = {}): ZipSpec => ({ name, data, ...extra });
const withManifest = (manifest: string, files: ZipSpec[]) => buildZip([file('imsmanifest.xml', manifest), ...files]);
const singleFiles = () => [file('index.html', html('Lesson 1')), file('shared/style.css', 'body { font-family: sans-serif; }')];

/** Named fixtures; every call builds fresh bytes. */
export const SCORM_FIXTURES = {
  scorm12Single: () => withManifest(single12(), singleFiles()),
  scorm12Multi: () =>
    withManifest(multi12(), [
      file('lessons/lesson1.html', html('Project charter')),
      file('lessons/lesson2.html', html('Stakeholders')),
      file('quiz/quiz.html', html('Final quiz')),
      file('shared/api.js', 'function findAPI(win) { return win.API; }'),
      file('shared/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ]),
  scorm2004: () => withManifest(scorm2004(), [file('content/privacy.html', html('Privacy')), file('content/use.html', html('Use')), file('content/common.js', '/* shared */')]),
  scorm2004Sequencing: () => withManifest(scorm2004(true), [file('content/privacy.html', html('Privacy')), file('content/use.html', html('Use')), file('content/common.js', '/* shared */')]),
  /** Warnings only: an undeclared version, a missing supporting file and a backslash path. */
  scorm12Warnings: () =>
    withManifest(
      manifest12({
        schemaVersion: null,
        items: [{ id: 'ITEM-1', title: 'Lesson', ref: 'RES-1' }],
        resources: [{ id: 'RES-1', title: '', href: 'pages\\start.html', files: ['pages/start.html', 'pages/missing.css'] }],
      }),
      [file('pages/start.html', html('Start'))],
    ),
  missingManifest: () => buildZip(singleFiles()),
  manifestInFolder: () => buildZip([file('course/imsmanifest.xml', single12()), file('course/index.html', html('Lesson 1'))]),
  malformedXml: () => withManifest('<?xml version="1.0"?><manifest identifier="x"><organizations><organization></manifest>', singleFiles()),
  doctype: () => withManifest(single12().replace('<manifest', '<!DOCTYPE manifest><manifest'), singleFiles()),
  entityExpansion: () =>
    withManifest(
      `<?xml version="1.0"?><!DOCTYPE manifest [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><manifest identifier="x"><metadata><schema>&c;</schema></metadata></manifest>`,
      singleFiles(),
    ),
  externalEntity: () =>
    withManifest(`<?xml version="1.0"?><!DOCTYPE manifest [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><manifest identifier="x"><metadata><schema>&xxe;</schema></metadata></manifest>`, singleFiles()),
  deepXml: () => withManifest(`<?xml version="1.0"?><manifest identifier="x">${'<a>'.repeat(80)}${'</a>'.repeat(80)}</manifest>`, singleFiles()),
  manyElements: () => withManifest(`<?xml version="1.0"?><manifest identifier="x">${'<a/>'.repeat(50_001)}</manifest>`, singleFiles()),
  missingLaunchFile: () =>
    withManifest(manifest12({ items: [{ id: 'ITEM-1', title: 'Lesson', ref: 'RES-1' }], resources: [{ id: 'RES-1', title: '', href: 'lesson.html' }] }), singleFiles()),
  invalidReference: () =>
    withManifest(
      manifest12({ items: [{ id: 'ITEM-1', title: 'Lesson', ref: 'NOPE' }], resources: [{ id: 'RES-1', title: '', href: 'index.html', dependencies: ['ALSO-NOPE'] }] }),
      singleFiles(),
    ),
  externalLaunch: () =>
    withManifest(manifest12({ items: [{ id: 'ITEM-1', title: 'Lesson', ref: 'RES-1' }], resources: [{ id: 'RES-1', title: '', href: 'https://attacker.example/launch.html', files: [] }] }), singleFiles()),
  dangerousLaunch: () =>
    withManifest(
      manifest12({
        items: [
          { id: 'ITEM-1', title: 'Script', ref: 'RES-1' },
          { id: 'ITEM-2', title: 'Data', ref: 'RES-2' },
        ],
        resources: [
          { id: 'RES-1', title: '', href: 'javascript:alert(document.cookie)', files: [] },
          { id: 'RES-2', title: '', href: 'data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;', files: [] },
        ],
      }),
      singleFiles(),
    ),
  hrefOutsidePackage: () =>
    withManifest(manifest12({ items: [{ id: 'ITEM-1', title: 'Lesson', ref: 'RES-1' }], resources: [{ id: 'RES-1', title: '', href: '../../etc/passwd', files: [] }] }), singleFiles()),
  pathTraversal: () => withManifest(single12(), [...singleFiles(), file('../../evil.html', html('Evil'))]),
  absolutePath: () => withManifest(single12(), [...singleFiles(), file('/etc/cron.d/evil', 'x')]),
  symlink: () => withManifest(single12(), [...singleFiles(), file('shared/passwd.html', '/etc/passwd', { method: 'store', unixMode: 0o120777 })]),
  encrypted: () => withManifest(single12(), [...singleFiles(), file('shared/secret.html', html('Secret'), { method: 'deflate', encrypted: true })]),
  duplicateNames: () => withManifest(single12(), [...singleFiles(), file('index.html', html('Other lesson'))]),
  caseCollision: () => withManifest(single12(), [...singleFiles(), file('INDEX.html', html('Other lesson'))]),
  unicodeCollision: () => withManifest(single12(), [...singleFiles(), file('café.html', 'nfc'), file('café.html', 'nfd')]),
  /** 4 MB of zeros compresses about 1000:1. */
  zipBombRatio: () => withManifest(single12(), [...singleFiles(), file('shared/zeros.bin', Buffer.alloc(4 * 1024 * 1024))]),
  /** Headers claim 3 × 90 MB (ratio below the per-entry limit) — refused before anything is decompressed. */
  zipBombTotal: () =>
    withManifest(single12(), [
      ...singleFiles(),
      ...[1, 2, 3].map((n) => file(`media/video${n}.bin`, randomBytes(1024 * 1024), { method: 'deflate', declaredSize: 90 * 1024 * 1024 })),
    ]),
  /** The header claims 10 bytes; the data inflates to 64 KB. */
  forgedSize: () => withManifest(single12(), [...singleFiles(), file('shared/forged.js', Buffer.alloc(64 * 1024, 0x61), { declaredSize: 10 })]),
  badChecksum: () => withManifest(single12(), [...singleFiles(), file('shared/damaged.js', 'console.log(1);', { crc: 0x12345678 })]),
  tooManyEntries: () => buildZip([file('imsmanifest.xml', single12()), ...Array.from({ length: 10_001 }, (_, n) => file(`f/${n}.txt`, ''))]),
  unsupportedVersion: () => withManifest(manifest12({ schemaVersion: '1.1', items: [{ id: 'ITEM-1', title: 'Lesson', ref: 'RES-1' }], resources: [{ id: 'RES-1', title: '', href: 'index.html' }] }), singleFiles()),
  unknownStandard: () =>
    withManifest(
      `<?xml version="1.0"?><manifest identifier="x" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"><organizations default="O"><organization identifier="O"><title>Plain package</title><item identifier="I" identifierref="R"><title>Page</title></item></organization></organizations><resources><resource identifier="R" type="webcontent" href="index.html"><file href="index.html"/></resource></resources></manifest>`,
      singleFiles(),
    ),
  commonCartridge: () =>
    withManifest(
      `<?xml version="1.0" encoding="UTF-8"?><manifest identifier="cc" xmlns="http://www.imsglobal.org/xsd/imsccv1p1/imscp_v1p1"><metadata><schema>IMS Common Cartridge</schema><schemaversion>1.1.0</schemaversion></metadata><organizations><organization identifier="O" structure="rooted-hierarchy"><item identifier="root"/></organization></organizations><resources><resource identifier="R" type="webcontent" href="wiki_content/page.html"><file href="wiki_content/page.html"/></resource></resources></manifest>`,
      [file('wiki_content/page.html', html('Canvas page')), file('course_settings/canvas_export.txt', 'Canvas export')],
    ),
  notZip: () => Buffer.from('This is not a ZIP archive, just text pretending to be one.'),
};

export type ScormFixture = keyof typeof SCORM_FIXTURES;

/** A valid SCORM 1.2 package padded with an uncompressible media file to about `megabytes` MB. */
export function largeValidPackage(megabytes: number): Buffer {
  return withManifest(single12(), [...singleFiles(), file('media/video.bin', randomBytes(megabytes * 1024 * 1024), { method: 'store' })]);
}
