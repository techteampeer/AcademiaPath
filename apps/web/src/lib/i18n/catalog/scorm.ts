// SCORM package inspection (AP-033B): a dry run that checks a package's structure. Nothing is imported or played.

type IssueCode =
  | 'SCORM_PACKAGE_TOO_LARGE'
  | 'SCORM_ARCHIVE_INVALID'
  | 'SCORM_ARCHIVE_TOO_MANY_ENTRIES'
  | 'SCORM_ARCHIVE_TOO_LARGE'
  | 'SCORM_ENTRY_TOO_LARGE'
  | 'SCORM_ENTRY_EXPANSION_RATIO'
  | 'SCORM_ENTRY_CORRUPT'
  | 'SCORM_ENTRY_ENCRYPTED'
  | 'SCORM_ENTRY_SYMLINK'
  | 'SCORM_ENTRY_SPECIAL_FILE'
  | 'SCORM_ENTRY_COMPRESSION_UNSUPPORTED'
  | 'SCORM_PATH_TRAVERSAL'
  | 'SCORM_PATH_ABSOLUTE'
  | 'SCORM_PATH_INVALID'
  | 'SCORM_PATH_DUPLICATE'
  | 'SCORM_PATH_COLLISION'
  | 'SCORM_MANIFEST_MISSING'
  | 'SCORM_MANIFEST_NOT_AT_ROOT'
  | 'SCORM_MANIFEST_TOO_LARGE'
  | 'SCORM_MANIFEST_ENCODING'
  | 'SCORM_MANIFEST_MALFORMED'
  | 'SCORM_MANIFEST_DOCTYPE'
  | 'SCORM_MANIFEST_TOO_DEEP'
  | 'SCORM_MANIFEST_TOO_MANY_ELEMENTS'
  | 'SCORM_MANIFEST_NOT_A_MANIFEST'
  | 'SCORM_MANIFEST_NAMESPACE_UNKNOWN'
  | 'SCORM_COMMON_CARTRIDGE'
  | 'SCORM_VERSION_UNSUPPORTED'
  | 'SCORM_VERSION_UNKNOWN'
  | 'SCORM_VERSION_INFERRED'
  | 'SCORM_VERSION_MISMATCH'
  | 'SCORM_METADATA_SCHEMA_UNEXPECTED'
  | 'SCORM_NO_ORGANIZATIONS'
  | 'SCORM_DEFAULT_ORGANIZATION_INVALID'
  | 'SCORM_DEFAULT_ORGANIZATION_MISSING'
  | 'SCORM_IDENTIFIER_MISSING'
  | 'SCORM_IDENTIFIER_DUPLICATE'
  | 'SCORM_ITEM_REFERENCE_INVALID'
  | 'SCORM_ITEM_WITHOUT_RESOURCE'
  | 'SCORM_RESOURCE_TYPE_UNSUPPORTED'
  | 'SCORM_SCORMTYPE_MISSING'
  | 'SCORM_SCORMTYPE_INVALID'
  | 'SCORM_DEPENDENCY_INVALID'
  | 'SCORM_LAUNCH_HREF_MISSING'
  | 'SCORM_LAUNCH_FILE_MISSING'
  | 'SCORM_FILE_MISSING'
  | 'SCORM_FILE_CASE_MISMATCH'
  | 'SCORM_HREF_EXTERNAL'
  | 'SCORM_HREF_DANGEROUS'
  | 'SCORM_HREF_INVALID'
  | 'SCORM_HREF_OUTSIDE_PACKAGE'
  | 'SCORM_HREF_BACKSLASH'
  | 'SCORM_LAUNCH_NOT_HTML'
  | 'SCORM_LAUNCH_FLASH'
  | 'SCORM_NO_LAUNCHABLE_CONTENT'
  | 'SCORM_SEQUENCING_IGNORED'
  | 'SCORM_SUBMANIFEST_UNSUPPORTED'
  | 'SCORM_INSPECTION_LIMIT'
  | 'SCORM_INSPECTION_FAILED';

const en = {
  title: 'Inspect a SCORM package',
  navLabel: 'SCORM inspection',
  loading: 'Loading the course…',
  notFound: 'Course not found',
  forbidden: 'Only the course design team, instructors and administrators can inspect SCORM packages.',
  intro:
    'Check the structure of a SCORM 1.2 or SCORM 2004 package (.zip). The package is only inspected: it is not imported, stored or published, and its content is never run.',
  playbackNotice: 'SCORM playback is not available in AcademiaPath yet, so packages cannot be added to a course for now.',
  formHeading: 'Choose a package',
  fileLabel: 'SCORM package (.zip)',
  fileHint: 'A .zip file of at most 25 MB with imsmanifest.xml at its root.',
  chooseFile: 'Choose a .zip file to inspect.',
  onlyZip: 'Only .zip files can be inspected.',
  tooLarge: 'This file is larger than 25 MB, the inspection limit.',
  rateLimited: 'Too many inspections in a short time. Wait a few minutes and try again.',
  inspect: 'Inspect package',
  inspecting: 'Inspecting…',
  inspectingStatus: 'Inspecting the package. This can take a few seconds.',
  another: 'Inspect another package',
  resultHeading: 'Inspection result',
  notImported: 'Not imported: nothing was added to the course, stored or published.',
  status: {
    valid: 'Valid package',
    valid_with_warnings: 'Valid package, with warnings',
    invalid: 'Invalid package',
  },
  statusDetail: {
    valid: 'The package structure is valid.',
    valid_with_warnings: 'The package structure is valid, but check the warnings below.',
    invalid: 'The package cannot be used as it is. Correct the errors below and inspect it again.',
  },
  summaryLabel: 'Package summary',
  fields: {
    standard: 'Standard',
    title: 'Title',
    file: 'File',
    size: 'Size',
    content: 'Content',
    playback: 'Playback in AcademiaPath',
  },
  standards: {
    scorm_1_2: 'SCORM 1.2',
    scorm_2004: 'SCORM 2004',
    scorm: 'SCORM, in a version that is not supported',
    common_cartridge: 'IMS Common Cartridge (not a SCORM package)',
    unknown: 'Not identified',
  },
  editions: { '2nd': '2nd Edition', '3rd': '3rd Edition', '4th': '4th Edition' },
  declared: (value: string) => `declared as “${value}”`,
  untitled: 'No title',
  unnamedFile: 'Unnamed file',
  sizes: (compressed: string, uncompressed: string | null) => (uncompressed ? `${compressed} compressed, ${uncompressed} uncompressed` : `${compressed} compressed`),
  bytes: (value: string, unit: 'B' | 'KB' | 'MB') => `${value} ${unit === 'B' ? 'bytes' : unit}`,
  contentCounts: (scos: number, assets: number, files: number) =>
    `${scos === 1 ? '1 SCO' : `${scos} SCOs`}, ${assets === 1 ? '1 asset' : `${assets} assets`}, ${files === 1 ? '1 file' : `${files} files`}`,
  playback: {
    planned: 'Not available yet; planned for a later version.',
    planned_without_sequencing: 'Not available yet; planned for a later version, without SCORM 2004 sequencing rules.',
    not_supported: 'Not possible for this package as inspected.',
  },
  commonCartridgeHint:
    'Canvas course exports are IMS Common Cartridge files, not SCORM packages. Importing Common Cartridge courses is planned separately.',
  launchableHeading: 'Launchable content',
  launchableIntro: 'The items a learner could open, in course order. Launch files are paths inside the package.',
  launchableEmpty: 'No launchable content was found.',
  sco: 'SCO',
  asset: 'Asset',
  hidden: 'Hidden',
  launchFile: 'Launch file',
  item: 'Item',
  resourcesHeading: (count: number) => (count === 1 ? 'Resources (1)' : `Resources (${count})`),
  noLaunchFile: 'No launch file',
  resourceDetail: (files: number, missing: number, dependencies: number) =>
    [files === 1 ? '1 listed file' : `${files} listed files`, missing ? `${missing} missing` : null, dependencies === 1 ? '1 dependency' : dependencies ? `${dependencies} dependencies` : null]
      .filter(Boolean)
      .join(' · '),
  issuesHeading: 'Errors and warnings',
  issueCounts: (errors: number, warnings: number) => `${errors === 1 ? '1 error' : `${errors} errors`}, ${warnings === 1 ? '1 warning' : `${warnings} warnings`}`,
  noIssues: 'No errors or warnings were found.',
  error: 'Error',
  warning: 'Warning',
  where: {
    path: (path: string) => `File: ${path}`,
    line: (line: number) => `imsmanifest.xml, line ${line}`,
    value: (value: string) => `Value: “${value}”`,
    limitBytes: (megabytes: string) => `Limit: ${megabytes} MB`,
    limitCount: (count: string) => `Limit: ${count}`,
    limitRatio: (ratio: string) => `Limit: ${ratio}:1`,
  },
  issuesTruncated: 'Only the first 200 errors and warnings are listed.',
  listsTruncated: 'Long lists show only their first 500 entries; the counts include everything.',
  libraryLink: 'Inspect a SCORM package',
  libraryHint: 'Check a SCORM .zip package before it can be used. SCORM packages cannot be added to courses yet.',
  issues: {
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
    SCORM_MANIFEST_MISSING: 'There is no imsmanifest.xml at the root of the package.',
    SCORM_MANIFEST_NOT_AT_ROOT: 'imsmanifest.xml is inside a folder: zip the contents of the folder, not the folder itself.',
    SCORM_MANIFEST_TOO_LARGE: 'imsmanifest.xml is larger than allowed.',
    SCORM_MANIFEST_ENCODING: 'imsmanifest.xml uses an unsupported or invalid character encoding.',
    SCORM_MANIFEST_MALFORMED: 'imsmanifest.xml is not well-formed XML.',
    SCORM_MANIFEST_DOCTYPE: 'imsmanifest.xml contains a document type declaration, which is not accepted.',
    SCORM_MANIFEST_TOO_DEEP: 'imsmanifest.xml is nested more deeply than allowed.',
    SCORM_MANIFEST_TOO_MANY_ELEMENTS: 'imsmanifest.xml contains more elements or attributes than allowed.',
    SCORM_MANIFEST_NOT_A_MANIFEST: 'imsmanifest.xml does not contain a manifest root element.',
    SCORM_MANIFEST_NAMESPACE_UNKNOWN: 'The manifest uses an unexpected namespace; it was inspected anyway.',
    SCORM_COMMON_CARTRIDGE: 'This is an IMS Common Cartridge (for example a Canvas course export), not a SCORM package.',
    SCORM_VERSION_UNSUPPORTED: 'The package declares a SCORM version that is not supported.',
    SCORM_VERSION_UNKNOWN: 'The package does not identify itself as SCORM 1.2 or SCORM 2004.',
    SCORM_VERSION_INFERRED: 'The manifest does not declare its SCORM version; it was inferred from its namespaces.',
    SCORM_VERSION_MISMATCH: 'The declared SCORM version does not match the namespaces the manifest uses.',
    SCORM_METADATA_SCHEMA_UNEXPECTED: 'The manifest metadata does not name the “ADL SCORM” schema.',
    SCORM_NO_ORGANIZATIONS: 'The manifest has no organization, so it has no course structure to launch.',
    SCORM_DEFAULT_ORGANIZATION_INVALID: 'The default organization does not exist.',
    SCORM_DEFAULT_ORGANIZATION_MISSING: 'No default organization is set; the first one is used.',
    SCORM_IDENTIFIER_MISSING: 'An organization, item or resource has no identifier.',
    SCORM_IDENTIFIER_DUPLICATE: 'The same identifier is used more than once.',
    SCORM_ITEM_REFERENCE_INVALID: 'An item refers to a resource that does not exist.',
    SCORM_ITEM_WITHOUT_RESOURCE: 'An item has neither child items nor a resource to launch.',
    SCORM_RESOURCE_TYPE_UNSUPPORTED: 'A resource is not of type “webcontent”.',
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
    SCORM_INSPECTION_LIMIT: 'Inspecting the package took too long or needed too much memory.',
    SCORM_INSPECTION_FAILED: 'The package could not be inspected.',
  } satisfies Record<IssueCode, string>,
};

type ScormMessages = typeof en;

const es: ScormMessages = {
  title: 'Revisar un paquete SCORM',
  navLabel: 'Revisión SCORM',
  loading: 'Cargando el curso…',
  notFound: 'Curso no encontrado',
  forbidden: 'Solo el equipo de diseño del curso, los instructores y los administradores pueden revisar paquetes SCORM.',
  intro:
    'Revisa la estructura de un paquete SCORM 1.2 o SCORM 2004 (.zip). El paquete solo se revisa: no se importa, no se guarda ni se publica, y su contenido nunca se ejecuta.',
  playbackNotice: 'La reproducción de SCORM aún no está disponible en AcademiaPath, así que por ahora los paquetes no se pueden agregar a un curso.',
  formHeading: 'Elige un paquete',
  fileLabel: 'Paquete SCORM (.zip)',
  fileHint: 'Un archivo .zip de 25 MB como máximo con imsmanifest.xml en su raíz.',
  chooseFile: 'Elige un archivo .zip para revisarlo.',
  onlyZip: 'Solo se pueden revisar archivos .zip.',
  tooLarge: 'Este archivo supera los 25 MB, el límite de revisión.',
  rateLimited: 'Demasiadas revisiones en poco tiempo. Espera unos minutos e inténtalo de nuevo.',
  inspect: 'Revisar paquete',
  inspecting: 'Revisando…',
  inspectingStatus: 'Revisando el paquete. Puede tardar unos segundos.',
  another: 'Revisar otro paquete',
  resultHeading: 'Resultado de la revisión',
  notImported: 'No importado: no se agregó nada al curso, ni se guardó ni se publicó.',
  status: {
    valid: 'Paquete válido',
    valid_with_warnings: 'Paquete válido, con advertencias',
    invalid: 'Paquete no válido',
  },
  statusDetail: {
    valid: 'La estructura del paquete es válida.',
    valid_with_warnings: 'La estructura del paquete es válida, pero revisa las advertencias de abajo.',
    invalid: 'El paquete no se puede usar tal como está. Corrige los errores de abajo y vuelve a revisarlo.',
  },
  summaryLabel: 'Resumen del paquete',
  fields: {
    standard: 'Estándar',
    title: 'Título',
    file: 'Archivo',
    size: 'Tamaño',
    content: 'Contenido',
    playback: 'Reproducción en AcademiaPath',
  },
  standards: {
    scorm_1_2: 'SCORM 1.2',
    scorm_2004: 'SCORM 2004',
    scorm: 'SCORM, en una versión que no se admite',
    common_cartridge: 'IMS Common Cartridge (no es un paquete SCORM)',
    unknown: 'No identificado',
  },
  editions: { '2nd': '2.ª edición', '3rd': '3.ª edición', '4th': '4.ª edición' },
  declared: (value: string) => `declarada como «${value}»`,
  untitled: 'Sin título',
  unnamedFile: 'Archivo sin nombre',
  sizes: (compressed: string, uncompressed: string | null) => (uncompressed ? `${compressed} comprimido, ${uncompressed} descomprimido` : `${compressed} comprimido`),
  bytes: (value: string, unit: 'B' | 'KB' | 'MB') => `${value} ${unit === 'B' ? 'bytes' : unit}`,
  contentCounts: (scos: number, assets: number, files: number) =>
    `${scos === 1 ? '1 SCO' : `${scos} SCO`}, ${assets === 1 ? '1 recurso de apoyo' : `${assets} recursos de apoyo`}, ${files === 1 ? '1 archivo' : `${files} archivos`}`,
  playback: {
    planned: 'Aún no disponible; prevista para una versión posterior.',
    planned_without_sequencing: 'Aún no disponible; prevista para una versión posterior, sin las reglas de secuenciación de SCORM 2004.',
    not_supported: 'No es posible para este paquete tal como se revisó.',
  },
  commonCartridgeHint:
    'Las exportaciones de cursos de Canvas son archivos IMS Common Cartridge, no paquetes SCORM. La importación de cursos Common Cartridge se planifica por separado.',
  launchableHeading: 'Contenido que se puede abrir',
  launchableIntro: 'Los elementos que un estudiante podría abrir, en el orden del curso. Los archivos de inicio son rutas dentro del paquete.',
  launchableEmpty: 'No se encontró contenido que se pueda abrir.',
  sco: 'SCO',
  asset: 'Recurso de apoyo',
  hidden: 'Oculto',
  launchFile: 'Archivo de inicio',
  item: 'Elemento',
  resourcesHeading: (count: number) => (count === 1 ? 'Recursos (1)' : `Recursos (${count})`),
  noLaunchFile: 'Sin archivo de inicio',
  resourceDetail: (files: number, missing: number, dependencies: number) =>
    [
      files === 1 ? '1 archivo listado' : `${files} archivos listados`,
      missing ? `${missing} ${missing === 1 ? 'falta' : 'faltan'}` : null,
      dependencies === 1 ? '1 dependencia' : dependencies ? `${dependencies} dependencias` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  issuesHeading: 'Errores y advertencias',
  issueCounts: (errors: number, warnings: number) => `${errors === 1 ? '1 error' : `${errors} errores`}, ${warnings === 1 ? '1 advertencia' : `${warnings} advertencias`}`,
  noIssues: 'No se encontraron errores ni advertencias.',
  error: 'Error',
  warning: 'Advertencia',
  where: {
    path: (path: string) => `Archivo: ${path}`,
    line: (line: number) => `imsmanifest.xml, línea ${line}`,
    value: (value: string) => `Valor: «${value}»`,
    limitBytes: (megabytes: string) => `Límite: ${megabytes} MB`,
    limitCount: (count: string) => `Límite: ${count}`,
    limitRatio: (ratio: string) => `Límite: ${ratio}:1`,
  },
  issuesTruncated: 'Solo se muestran los primeros 200 errores y advertencias.',
  listsTruncated: 'Las listas largas muestran solo sus primeras 500 entradas; los totales incluyen todo.',
  libraryLink: 'Revisar un paquete SCORM',
  libraryHint: 'Revisa un paquete SCORM .zip antes de poder usarlo. Los paquetes SCORM aún no se pueden agregar a los cursos.',
  issues: {
    SCORM_PACKAGE_TOO_LARGE: 'El paquete supera el límite de revisión.',
    SCORM_ARCHIVE_INVALID: 'El archivo no es un ZIP legible.',
    SCORM_ARCHIVE_TOO_MANY_ENTRIES: 'El ZIP contiene más archivos y carpetas de los permitidos.',
    SCORM_ARCHIVE_TOO_LARGE: 'El ZIP se descomprime en más datos de los permitidos (posible bomba ZIP).',
    SCORM_ENTRY_TOO_LARGE: 'Un archivo del ZIP se descomprime en más datos de los permitidos.',
    SCORM_ENTRY_EXPANSION_RATIO: 'Un archivo del ZIP está mucho más comprimido que un contenido normal (posible bomba ZIP).',
    SCORM_ENTRY_CORRUPT: 'Un archivo del ZIP está dañado: su tamaño o su suma de verificación no coincide.',
    SCORM_ENTRY_ENCRYPTED: 'El ZIP contiene un archivo cifrado.',
    SCORM_ENTRY_SYMLINK: 'El ZIP contiene un enlace simbólico.',
    SCORM_ENTRY_SPECIAL_FILE: 'El ZIP contiene un dispositivo, una tubería u otro archivo especial.',
    SCORM_ENTRY_COMPRESSION_UNSUPPORTED: 'Un archivo del ZIP usa un método de compresión no admitido.',
    SCORM_PATH_TRAVERSAL: 'Un nombre de archivo del ZIP apunta fuera del paquete («..»).',
    SCORM_PATH_ABSOLUTE: 'Un nombre de archivo del ZIP es una ruta absoluta.',
    SCORM_PATH_INVALID: 'Un nombre de archivo del ZIP tiene caracteres no válidos o peligrosos, o es demasiado largo o profundo.',
    SCORM_PATH_DUPLICATE: 'El ZIP contiene el mismo nombre de archivo más de una vez.',
    SCORM_PATH_COLLISION: 'Dos nombres de archivo del ZIP solo se diferencian en mayúsculas o en su forma Unicode.',
    SCORM_MANIFEST_MISSING: 'No hay un imsmanifest.xml en la raíz del paquete.',
    SCORM_MANIFEST_NOT_AT_ROOT: 'imsmanifest.xml está dentro de una carpeta: comprime el contenido de la carpeta, no la carpeta misma.',
    SCORM_MANIFEST_TOO_LARGE: 'imsmanifest.xml es más grande de lo permitido.',
    SCORM_MANIFEST_ENCODING: 'imsmanifest.xml usa una codificación de caracteres no admitida o no válida.',
    SCORM_MANIFEST_MALFORMED: 'imsmanifest.xml no es un XML bien formado.',
    SCORM_MANIFEST_DOCTYPE: 'imsmanifest.xml contiene una declaración de tipo de documento, que no se acepta.',
    SCORM_MANIFEST_TOO_DEEP: 'imsmanifest.xml tiene más niveles de anidación de los permitidos.',
    SCORM_MANIFEST_TOO_MANY_ELEMENTS: 'imsmanifest.xml tiene más elementos o atributos de los permitidos.',
    SCORM_MANIFEST_NOT_A_MANIFEST: 'imsmanifest.xml no tiene un elemento raíz manifest.',
    SCORM_MANIFEST_NAMESPACE_UNKNOWN: 'El manifiesto usa un espacio de nombres inesperado; se revisó de todos modos.',
    SCORM_COMMON_CARTRIDGE: 'Es un IMS Common Cartridge (por ejemplo, una exportación de curso de Canvas), no un paquete SCORM.',
    SCORM_VERSION_UNSUPPORTED: 'El paquete declara una versión de SCORM que no se admite.',
    SCORM_VERSION_UNKNOWN: 'El paquete no se identifica como SCORM 1.2 ni como SCORM 2004.',
    SCORM_VERSION_INFERRED: 'El manifiesto no declara su versión de SCORM; se dedujo de sus espacios de nombres.',
    SCORM_VERSION_MISMATCH: 'La versión de SCORM declarada no coincide con los espacios de nombres del manifiesto.',
    SCORM_METADATA_SCHEMA_UNEXPECTED: 'Los metadatos del manifiesto no indican el esquema «ADL SCORM».',
    SCORM_NO_ORGANIZATIONS: 'El manifiesto no tiene ninguna organización, así que no tiene estructura de curso que abrir.',
    SCORM_DEFAULT_ORGANIZATION_INVALID: 'La organización predeterminada no existe.',
    SCORM_DEFAULT_ORGANIZATION_MISSING: 'No hay una organización predeterminada; se usa la primera.',
    SCORM_IDENTIFIER_MISSING: 'Una organización, un elemento o un recurso no tiene identificador.',
    SCORM_IDENTIFIER_DUPLICATE: 'El mismo identificador se usa más de una vez.',
    SCORM_ITEM_REFERENCE_INVALID: 'Un elemento hace referencia a un recurso que no existe.',
    SCORM_ITEM_WITHOUT_RESOURCE: 'Un elemento no tiene elementos hijos ni un recurso que abrir.',
    SCORM_RESOURCE_TYPE_UNSUPPORTED: 'Un recurso no es del tipo «webcontent».',
    SCORM_SCORMTYPE_MISSING: 'Un recurso no indica si es un SCO o un recurso de apoyo; se trata como recurso de apoyo.',
    SCORM_SCORMTYPE_INVALID: 'Un recurso tiene un tipo SCORM desconocido; se trata como recurso de apoyo.',
    SCORM_DEPENDENCY_INVALID: 'Un recurso depende de un recurso que no existe.',
    SCORM_LAUNCH_HREF_MISSING: 'Un elemento que se puede abrir hace referencia a un recurso sin archivo de inicio.',
    SCORM_LAUNCH_FILE_MISSING: 'Un archivo de inicio no está en el paquete.',
    SCORM_FILE_MISSING: 'Un archivo listado en el manifiesto no está en el paquete.',
    SCORM_FILE_CASE_MISMATCH: 'Se hace referencia a un archivo con mayúsculas o minúsculas distintas de su nombre en el paquete.',
    SCORM_HREF_EXTERNAL: 'Un recurso hace referencia a una dirección web externa; el contenido externo no se carga.',
    SCORM_HREF_DANGEROUS: 'Un recurso hace referencia a una dirección peligrosa (por ejemplo, javascript: o data:).',
    SCORM_HREF_INVALID: 'La dirección de un recurso no es una ruta relativa válida.',
    SCORM_HREF_OUTSIDE_PACKAGE: 'La dirección de un recurso apunta fuera del paquete.',
    SCORM_HREF_BACKSLASH: 'La dirección de un recurso usa barras invertidas; se leyeron como barras normales.',
    SCORM_LAUNCH_NOT_HTML: 'Un archivo de inicio no es una página HTML.',
    SCORM_LAUNCH_FLASH: 'Un archivo de inicio es contenido Flash, que los navegadores modernos no pueden reproducir.',
    SCORM_NO_LAUNCHABLE_CONTENT: 'El paquete no tiene ningún elemento que se pueda abrir.',
    SCORM_SEQUENCING_IGNORED: 'El paquete define reglas de secuenciación de SCORM 2004; no se aplicarán.',
    SCORM_SUBMANIFEST_UNSUPPORTED: 'El paquete contiene manifiestos anidados (submanifiestos), que no se admiten.',
    SCORM_INSPECTION_LIMIT: 'La revisión del paquete tardó demasiado o necesitó demasiada memoria.',
    SCORM_INSPECTION_FAILED: 'No se pudo revisar el paquete.',
  },
};

export const scorm = { en, es };
