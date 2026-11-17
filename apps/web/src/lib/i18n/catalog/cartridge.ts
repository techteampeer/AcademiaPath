// IMS Common Cartridge inspection (AP-038D): a dry run that reports a package's structure and how it relates to
// AcademiaPath. Nothing is imported, stored, published, executed or fetched.

type IssueCode =
  | 'CARTRIDGE_ARCHIVE_INVALID'
  | 'CARTRIDGE_ARCHIVE_TOO_MANY_ENTRIES'
  | 'CARTRIDGE_ARCHIVE_TOO_LARGE'
  | 'CARTRIDGE_ARCHIVE_EMPTY'
  | 'CARTRIDGE_PATH_TRAVERSAL'
  | 'CARTRIDGE_PATH_ABSOLUTE'
  | 'CARTRIDGE_PATH_INVALID'
  | 'CARTRIDGE_PATH_DUPLICATE'
  | 'CARTRIDGE_PATH_COLLISION'
  | 'CARTRIDGE_ENTRY_ENCRYPTED'
  | 'CARTRIDGE_ENTRY_SYMLINK'
  | 'CARTRIDGE_ENTRY_SPECIAL_FILE'
  | 'CARTRIDGE_ENTRY_COMPRESSION_UNSUPPORTED'
  | 'CARTRIDGE_ENTRY_TOO_LARGE'
  | 'CARTRIDGE_ENTRY_EXPANSION_RATIO'
  | 'CARTRIDGE_ENTRY_CORRUPT'
  | 'CARTRIDGE_MANIFEST_MISSING'
  | 'CARTRIDGE_MANIFEST_NESTED'
  | 'CARTRIDGE_MANIFEST_TOO_LARGE'
  | 'CARTRIDGE_MANIFEST_ENCODING'
  | 'CARTRIDGE_MANIFEST_MALFORMED'
  | 'CARTRIDGE_MANIFEST_DOCTYPE'
  | 'CARTRIDGE_MANIFEST_TOO_DEEP'
  | 'CARTRIDGE_MANIFEST_TOO_MANY_ELEMENTS'
  | 'CARTRIDGE_MANIFEST_ROOT_INVALID'
  | 'CARTRIDGE_IS_SCORM'
  | 'CARTRIDGE_NOT_CARTRIDGE'
  | 'CARTRIDGE_VERSION_UNSUPPORTED'
  | 'CARTRIDGE_VERSION_UNDECLARED'
  | 'CARTRIDGE_VERSION_MISMATCH'
  | 'CARTRIDGE_THIN'
  | 'CARTRIDGE_CANVAS_EXTENSIONS'
  | 'CARTRIDGE_ORGANIZATION_MISSING'
  | 'CARTRIDGE_ORGANIZATION_MULTIPLE'
  | 'CARTRIDGE_ORGANIZATION_NESTED'
  | 'CARTRIDGE_ITEM_RESOURCE_MISSING'
  | 'CARTRIDGE_RESOURCES_EMPTY'
  | 'CARTRIDGE_RESOURCE_IDENTIFIER_MISSING'
  | 'CARTRIDGE_RESOURCE_IDENTIFIER_DUPLICATE'
  | 'CARTRIDGE_RESOURCE_FILE_MISSING'
  | 'CARTRIDGE_RESOURCE_HREF_OUTSIDE'
  | 'CARTRIDGE_RESOURCE_HREF_DANGEROUS'
  | 'CARTRIDGE_RESOURCE_HREF_INVALID'
  | 'CARTRIDGE_RESOURCE_HREF_EXTERNAL'
  | 'CARTRIDGE_DEPENDENCY_MISSING'
  | 'CARTRIDGE_RESOURCE_TYPE_UNKNOWN'
  | 'CARTRIDGE_RESOURCE_INLINE'
  | 'CARTRIDGE_DESCRIPTOR_MALFORMED'
  | 'CARTRIDGE_DESCRIPTOR_DOCTYPE'
  | 'CARTRIDGE_DESCRIPTOR_LIMIT'
  | 'CARTRIDGE_QTI_VERSION_UNSUPPORTED'
  | 'CARTRIDGE_QUESTION_TYPE_UNSUPPORTED'
  | 'CARTRIDGE_ASSESSMENT_EMPTY'
  | 'CARTRIDGE_LINK_BROKEN'
  | 'CARTRIDGE_LINK_DANGEROUS'
  | 'CARTRIDGE_WEBLINK_INSECURE'
  | 'CARTRIDGE_INSPECTION_FAILED'
  | 'CARTRIDGE_INSPECTION_LIMIT';

const en = {
  title: 'Inspect a Common Cartridge',
  navLabel: 'Common Cartridge inspection',
  loading: 'Loading…',
  notFound: 'Course not found',
  forbidden: 'Only course content editors and administrators can inspect Common Cartridge packages.',
  intro:
    'Check an IMS Common Cartridge (.imscc), such as a Canvas course export, before planning a migration. This is a dry run: nothing is imported, stored or published, and nothing in the package is executed or opened.',
  importNotice: 'Importing Common Cartridge content is not available yet. The report shows what could map to AcademiaPath and what would need work.',
  formHeading: 'Choose a package',
  fileLabel: 'Common Cartridge package',
  fileHint: 'An .imscc (or .zip) file of at most 25 MB.',
  chooseFile: 'Choose an .imscc file to inspect.',
  onlyCartridge: 'Choose an .imscc or .zip file.',
  tooLarge: 'The file is larger than the 25 MB inspection limit.',
  rateLimited: 'Too many inspections in a short time. Wait a few minutes and try again.',
  inspect: 'Inspect package',
  inspecting: 'Inspecting…',
  inspectingStatus: 'Inspecting the package. This can take a few seconds.',
  another: 'Inspect another package',
  resultHeading: 'Inspection report',
  notImported: 'Nothing was imported, stored or published. Classifications describe possible mappings only.',
  status: { valid: 'Structure is valid', valid_with_warnings: 'Valid, with warnings', invalid: 'Not valid or not inspectable' },
  statusDetail: {
    valid: 'The package was read completely and no problems were found.',
    valid_with_warnings: 'The package was read; review the warnings below.',
    invalid: 'The package has problems that must be fixed, or it cannot be inspected. See the errors below.',
  },
  summaryLabel: 'Package summary',
  fields: { format: 'Format', title: 'Title', file: 'File', size: 'Size', canvas: 'Canvas export', content: 'Content', language: 'Language' },
  formats: {
    common_cartridge: 'IMS Common Cartridge package',
    thin_common_cartridge: 'IMS Thin Common Cartridge package',
    scorm: 'SCORM package',
    ims_content_package: 'IMS content package',
    unknown: 'Not identified',
  },
  version: (version: string) => `version ${version}`,
  declared: (value: string) => `declared: ${value}`,
  canvasDetected: 'Yes — Canvas-specific extensions found',
  canvasNotDetected: 'Not detected',
  untitled: 'No title',
  unnamedFile: 'Unnamed file',
  sizes: (compressed: string, uncompressed: string | null) => (uncompressed ? `${compressed} compressed, ${uncompressed} uncompressed` : `${compressed} compressed`),
  bytes: (value: string, unit: string) => `${value} ${unit}`,
  contentCounts: (modules: number, items: number, resources: number, questions: number) =>
    `${modules} ${modules === 1 ? 'module' : 'modules'}, ${items} outline ${items === 1 ? 'item' : 'items'}, ${resources} ${resources === 1 ? 'resource' : 'resources'}, ${questions} ${questions === 1 ? 'question' : 'questions'}`,
  compatibilityHeading: 'Compatibility with AcademiaPath',
  compatibilityIntro: 'How the content relates to existing AcademiaPath features. Nothing is imported: this is a planning aid.',
  compatibilityEmpty: 'There is no content to compare.',
  columns: { content: 'Content', count: 'Count', target: 'AcademiaPath feature', support: 'Support' },
  kinds: {
    module: 'Modules',
    page: 'Pages',
    file: 'Files',
    assessment: 'Quizzes and assessments',
    question_bank: 'Question banks',
    assignment: 'Assignments',
    discussion: 'Discussions',
    web_link: 'Web links',
    lti_link: 'LTI tools',
    canvas_settings: 'Canvas course settings',
    learning_application: 'Other application resources',
    other_standard: 'Other standard resources (IWB, EPUB, APIP)',
    unknown: 'Unknown resources',
  },
  targets: { section: 'Course units', lesson: 'Lessons', document: 'Documents', quiz: 'Quizzes', assignment: 'Assignments', forum: 'Course forum', link: 'Links', none: '—' },
  support: { direct: 'Directly supported', transform: 'Requires transformation', new_functionality: 'Requires new functionality', unsupported: 'Unsupported' },
  classifications: { recognized: 'Recognized', mappable: 'Potentially mappable', transform: 'Needs transformation', unsupported: 'Unsupported', invalid: 'Invalid' },
  classificationsLegend:
    'Recognized: understood, used by other content. Potentially mappable: matches an existing feature, but nothing is imported. Needs transformation: would need conversion first. Unsupported: no AcademiaPath counterpart. Invalid: broken or unsafe.',
  outlineHeading: 'Course outline',
  outlineEmpty: 'The package has no course outline.',
  moduleItems: (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`,
  untitledModule: 'Untitled module',
  textHeading: 'Heading or folder (no content)',
  resourcesHeading: (n: number) => `Resources (${n})`,
  canvasBadge: 'Canvas',
  questions: (n: number) => `${n} ${n === 1 ? 'question' : 'questions'}`,
  questionTypes: {
    multiple_choice: 'Single answer',
    multiple_response: 'Multiple answers',
    true_false: 'True / false',
    fill_in_blank: 'Fill in the blank',
    fill_in_multiple_blanks: 'Fill in multiple blanks',
    multiple_dropdowns: 'Multiple dropdowns',
    pattern_match: 'Pattern match',
    essay: 'Essay',
    matching: 'Matching',
    numerical: 'Numerical',
    calculated: 'Calculated',
    file_upload: 'File upload',
    text_only: 'Text only (not a question)',
    unknown: 'Unidentified type',
  } as Record<string, string>,
  notSupportedType: 'not supported',
  address: (url: string) => `Address (not opened): ${url}`,
  submissionTypes: (types: string) => `Submission types: ${types}`,
  links: (external: number, broken: number, canvas: number) => `${external} external links (not opened), ${broken} broken references, ${canvas} Canvas links`,
  missingFiles: (n: number) => `${n} missing ${n === 1 ? 'file' : 'files'}`,
  issuesHeading: 'Errors and warnings',
  issueCounts: (errors: number, warnings: number) => `${errors} ${errors === 1 ? 'error' : 'errors'}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`,
  noIssues: 'No errors or warnings.',
  error: 'Error',
  warning: 'Warning',
  where: {
    path: (path: string) => `Location: ${path}`,
    line: (line: number) => `Line ${line} of imsmanifest.xml`,
    value: (value: string) => `Value: ${value}`,
    limitBytes: (mb: string) => `Limit: ${mb} MB`,
    limitCount: (n: string) => `Limit: ${n}`,
  },
  issuesTruncated: 'Only the first 200 issues are listed; the counts include all of them.',
  listsTruncated: 'Long lists are cut at 500 entries; the counts include everything.',
  libraryLink: 'Inspect a Common Cartridge',
  libraryHint: 'Check a Canvas or other .imscc export before a migration (dry run).',
  issues: {
    CARTRIDGE_ARCHIVE_INVALID: 'The file is not a readable ZIP archive.',
    CARTRIDGE_ARCHIVE_TOO_MANY_ENTRIES: 'The archive has more files and folders than the inspection limit.',
    CARTRIDGE_ARCHIVE_TOO_LARGE: 'The archive expands beyond the total size limit.',
    CARTRIDGE_ARCHIVE_EMPTY: 'The archive contains no files.',
    CARTRIDGE_PATH_TRAVERSAL: 'A file name tries to leave the package folder (".."). The package was not read further.',
    CARTRIDGE_PATH_ABSOLUTE: 'A file name is an absolute path. The package was not read further.',
    CARTRIDGE_PATH_INVALID: 'A file name is not a valid package path.',
    CARTRIDGE_PATH_DUPLICATE: 'Two files have the same name.',
    CARTRIDGE_PATH_COLLISION: 'Two files have names that differ only in capital letters or accents.',
    CARTRIDGE_ENTRY_ENCRYPTED: 'A file is encrypted.',
    CARTRIDGE_ENTRY_SYMLINK: 'A file is a symbolic link, which is not allowed.',
    CARTRIDGE_ENTRY_SPECIAL_FILE: 'An entry is not a regular file or folder.',
    CARTRIDGE_ENTRY_COMPRESSION_UNSUPPORTED: 'A file uses an unsupported compression method.',
    CARTRIDGE_ENTRY_TOO_LARGE: 'A file is larger than the per-file limit once decompressed.',
    CARTRIDGE_ENTRY_EXPANSION_RATIO: 'A file expands far beyond its compressed size (a possible ZIP bomb).',
    CARTRIDGE_ENTRY_CORRUPT: 'A file is damaged, or its declared size or checksum is wrong.',
    CARTRIDGE_MANIFEST_MISSING: 'The package has no imsmanifest.xml at its root.',
    CARTRIDGE_MANIFEST_NESTED: 'imsmanifest.xml is inside a folder. Export or zip the package so that it is at the root.',
    CARTRIDGE_MANIFEST_TOO_LARGE: 'imsmanifest.xml is larger than the inspection limit.',
    CARTRIDGE_MANIFEST_ENCODING: 'imsmanifest.xml uses an unsupported or invalid text encoding.',
    CARTRIDGE_MANIFEST_MALFORMED: 'imsmanifest.xml is not well-formed XML.',
    CARTRIDGE_MANIFEST_DOCTYPE: 'imsmanifest.xml declares a DOCTYPE, which is refused for safety (entities are never expanded or opened).',
    CARTRIDGE_MANIFEST_TOO_DEEP: 'imsmanifest.xml is nested too deeply.',
    CARTRIDGE_MANIFEST_TOO_MANY_ELEMENTS: 'imsmanifest.xml has too many elements or attributes.',
    CARTRIDGE_MANIFEST_ROOT_INVALID: 'imsmanifest.xml does not start with a <manifest> element.',
    CARTRIDGE_IS_SCORM: 'This is a SCORM package, not a Common Cartridge. Use the SCORM inspection instead.',
    CARTRIDGE_NOT_CARTRIDGE: 'The manifest does not declare an IMS Common Cartridge.',
    CARTRIDGE_VERSION_UNSUPPORTED: 'This Common Cartridge version is not supported by the inspector (supported: 1.0, 1.1, 1.2 and 1.3). It was not read as an older version.',
    CARTRIDGE_VERSION_UNDECLARED: 'The manifest does not state its version; it was identified from the manifest namespace.',
    CARTRIDGE_VERSION_MISMATCH: 'The declared version and the manifest namespace name different versions; the declared version was used.',
    CARTRIDGE_THIN: 'This is a Thin Common Cartridge: it holds links and LTI tools, not course content.',
    CARTRIDGE_CANVAS_EXTENSIONS: 'The package contains Canvas-specific extensions that are not part of the Common Cartridge standard.',
    CARTRIDGE_ORGANIZATION_MISSING: 'The package has no course outline (modules).',
    CARTRIDGE_ORGANIZATION_MULTIPLE: 'The package has more than one course outline; only the first was inspected.',
    CARTRIDGE_ORGANIZATION_NESTED: 'The outline has folders inside modules; AcademiaPath course units are one level deep, so they would need flattening.',
    CARTRIDGE_ITEM_RESOURCE_MISSING: 'An outline item refers to a resource that does not exist.',
    CARTRIDGE_RESOURCES_EMPTY: 'The package lists no resources.',
    CARTRIDGE_RESOURCE_IDENTIFIER_MISSING: 'A resource has no identifier.',
    CARTRIDGE_RESOURCE_IDENTIFIER_DUPLICATE: 'Two resources have the same identifier.',
    CARTRIDGE_RESOURCE_FILE_MISSING: 'A resource refers to a file that is not in the package.',
    CARTRIDGE_RESOURCE_HREF_OUTSIDE: 'A resource reference leaves the package folder.',
    CARTRIDGE_RESOURCE_HREF_DANGEROUS: 'A resource reference uses a dangerous scheme (javascript:, data:, file: or similar).',
    CARTRIDGE_RESOURCE_HREF_INVALID: 'A resource reference is not a valid package path.',
    CARTRIDGE_RESOURCE_HREF_EXTERNAL: 'A resource that should be inside the package points to an external address (it was not opened).',
    CARTRIDGE_DEPENDENCY_MISSING: 'A resource depends on a resource that does not exist.',
    CARTRIDGE_RESOURCE_TYPE_UNKNOWN: 'A resource has a type the inspector does not recognize.',
    CARTRIDGE_RESOURCE_INLINE: 'A resource describes its content inside the manifest; that description was not inspected.',
    CARTRIDGE_DESCRIPTOR_MALFORMED: 'A resource description file is not well-formed XML.',
    CARTRIDGE_DESCRIPTOR_DOCTYPE: 'A resource description file declares a DOCTYPE, which is refused for safety.',
    CARTRIDGE_DESCRIPTOR_LIMIT: 'A resource description or page is larger than the inspection limits and was not read.',
    CARTRIDGE_QTI_VERSION_UNSUPPORTED: 'An assessment uses a QTI version other than 1.2, which the inspector does not read.',
    CARTRIDGE_QUESTION_TYPE_UNSUPPORTED: 'An assessment uses question types that AcademiaPath quizzes do not support.',
    CARTRIDGE_ASSESSMENT_EMPTY: 'An assessment has no questions.',
    CARTRIDGE_LINK_BROKEN: 'A page refers to a file that is not in the package.',
    CARTRIDGE_LINK_DANGEROUS: 'A page or link uses a dangerous scheme (javascript:, data:, file: or similar).',
    CARTRIDGE_WEBLINK_INSECURE: 'A web link does not use https; AcademiaPath links must use https.',
    CARTRIDGE_INSPECTION_FAILED: 'The package could not be inspected.',
    CARTRIDGE_INSPECTION_LIMIT: 'Inspecting the package took too long or needed too much memory.',
  } satisfies Record<IssueCode, string>,
};

export type CartridgeMessages = typeof en;

const es: CartridgeMessages = {
  title: 'Revisar un Common Cartridge',
  navLabel: 'Revisión de Common Cartridge',
  loading: 'Cargando…',
  notFound: 'Curso no encontrado',
  forbidden: 'Solo los editores de contenido del curso y los administradores pueden revisar paquetes Common Cartridge.',
  intro:
    'Revisa un IMS Common Cartridge (.imscc), como una exportación de un curso de Canvas, antes de planificar una migración. Es una simulación: no se importa, guarda ni publica nada, y nada del paquete se ejecuta ni se abre.',
  importNotice: 'La importación de contenido Common Cartridge aún no está disponible. El informe muestra qué podría corresponder a AcademiaPath y qué requeriría trabajo.',
  formHeading: 'Elige un paquete',
  fileLabel: 'Paquete Common Cartridge',
  fileHint: 'Un archivo .imscc (o .zip) de 25 MB como máximo.',
  chooseFile: 'Elige un archivo .imscc para revisar.',
  onlyCartridge: 'Elige un archivo .imscc o .zip.',
  tooLarge: 'El archivo supera el límite de revisión de 25 MB.',
  rateLimited: 'Demasiadas revisiones en poco tiempo. Espera unos minutos e inténtalo de nuevo.',
  inspect: 'Revisar paquete',
  inspecting: 'Revisando…',
  inspectingStatus: 'Revisando el paquete. Puede tardar unos segundos.',
  another: 'Revisar otro paquete',
  resultHeading: 'Informe de revisión',
  notImported: 'No se importó, guardó ni publicó nada. Las clasificaciones describen solo posibles correspondencias.',
  status: { valid: 'La estructura es válida', valid_with_warnings: 'Válido, con advertencias', invalid: 'No es válido o no se puede revisar' },
  statusDetail: {
    valid: 'El paquete se leyó por completo y no se encontraron problemas.',
    valid_with_warnings: 'El paquete se leyó; revisa las advertencias a continuación.',
    invalid: 'El paquete tiene problemas que deben corregirse o no se puede revisar. Consulta los errores a continuación.',
  },
  summaryLabel: 'Resumen del paquete',
  fields: { format: 'Formato', title: 'Título', file: 'Archivo', size: 'Tamaño', canvas: 'Exportación de Canvas', content: 'Contenido', language: 'Idioma' },
  formats: {
    common_cartridge: 'Paquete IMS Common Cartridge',
    thin_common_cartridge: 'Paquete IMS Thin Common Cartridge',
    scorm: 'Paquete SCORM',
    ims_content_package: 'Paquete de contenido IMS',
    unknown: 'No identificado',
  },
  version: (version: string) => `versión ${version}`,
  declared: (value: string) => `declarada: ${value}`,
  canvasDetected: 'Sí: se encontraron extensiones propias de Canvas',
  canvasNotDetected: 'No detectada',
  untitled: 'Sin título',
  unnamedFile: 'Archivo sin nombre',
  sizes: (compressed: string, uncompressed: string | null) => (uncompressed ? `${compressed} comprimido, ${uncompressed} sin comprimir` : `${compressed} comprimido`),
  bytes: (value: string, unit: string) => `${value} ${unit}`,
  contentCounts: (modules: number, items: number, resources: number, questions: number) =>
    `${modules} ${modules === 1 ? 'módulo' : 'módulos'}, ${items} ${items === 1 ? 'elemento' : 'elementos'} del esquema, ${resources} ${resources === 1 ? 'recurso' : 'recursos'}, ${questions} ${questions === 1 ? 'pregunta' : 'preguntas'}`,
  compatibilityHeading: 'Compatibilidad con AcademiaPath',
  compatibilityIntro: 'Cómo se relaciona el contenido con las funciones existentes de AcademiaPath. No se importa nada: es una ayuda para planificar.',
  compatibilityEmpty: 'No hay contenido que comparar.',
  columns: { content: 'Contenido', count: 'Cantidad', target: 'Función de AcademiaPath', support: 'Compatibilidad' },
  kinds: {
    module: 'Módulos',
    page: 'Páginas',
    file: 'Archivos',
    assessment: 'Cuestionarios y evaluaciones',
    question_bank: 'Bancos de preguntas',
    assignment: 'Tareas',
    discussion: 'Debates',
    web_link: 'Enlaces web',
    lti_link: 'Herramientas LTI',
    canvas_settings: 'Configuración del curso de Canvas',
    learning_application: 'Otros recursos de aplicación',
    other_standard: 'Otros recursos estándar (IWB, EPUB, APIP)',
    unknown: 'Recursos desconocidos',
  },
  targets: { section: 'Unidades del curso', lesson: 'Lecciones', document: 'Documentos', quiz: 'Cuestionarios', assignment: 'Tareas', forum: 'Foro del curso', link: 'Enlaces', none: '—' },
  support: { direct: 'Compatible directamente', transform: 'Requiere transformación', new_functionality: 'Requiere nuevas funciones', unsupported: 'No compatible' },
  classifications: { recognized: 'Reconocido', mappable: 'Posiblemente compatible', transform: 'Requiere transformación', unsupported: 'No compatible', invalid: 'No válido' },
  classificationsLegend:
    'Reconocido: se entiende y lo usa otro contenido. Posiblemente compatible: corresponde a una función existente, pero no se importa nada. Requiere transformación: necesitaría una conversión previa. No compatible: no tiene equivalente en AcademiaPath. No válido: dañado o inseguro.',
  outlineHeading: 'Esquema del curso',
  outlineEmpty: 'El paquete no tiene esquema del curso.',
  moduleItems: (n: number) => `${n} ${n === 1 ? 'elemento' : 'elementos'}`,
  untitledModule: 'Módulo sin título',
  textHeading: 'Encabezado o carpeta (sin contenido)',
  resourcesHeading: (n: number) => `Recursos (${n})`,
  canvasBadge: 'Canvas',
  questions: (n: number) => `${n} ${n === 1 ? 'pregunta' : 'preguntas'}`,
  questionTypes: {
    multiple_choice: 'Respuesta única',
    multiple_response: 'Respuestas múltiples',
    true_false: 'Verdadero / falso',
    fill_in_blank: 'Completar el espacio',
    fill_in_multiple_blanks: 'Completar varios espacios',
    multiple_dropdowns: 'Varias listas desplegables',
    pattern_match: 'Coincidencia de patrón',
    essay: 'Ensayo',
    matching: 'Relacionar',
    numerical: 'Numérica',
    calculated: 'Calculada',
    file_upload: 'Subir archivo',
    text_only: 'Solo texto (no es una pregunta)',
    unknown: 'Tipo no identificado',
  },
  notSupportedType: 'no compatible',
  address: (url: string) => `Dirección (no se abrió): ${url}`,
  submissionTypes: (types: string) => `Tipos de entrega: ${types}`,
  links: (external: number, broken: number, canvas: number) => `${external} enlaces externos (no se abrieron), ${broken} referencias rotas, ${canvas} enlaces de Canvas`,
  missingFiles: (n: number) => `${n} ${n === 1 ? 'archivo faltante' : 'archivos faltantes'}`,
  issuesHeading: 'Errores y advertencias',
  issueCounts: (errors: number, warnings: number) => `${errors} ${errors === 1 ? 'error' : 'errores'}, ${warnings} ${warnings === 1 ? 'advertencia' : 'advertencias'}`,
  noIssues: 'Sin errores ni advertencias.',
  error: 'Error',
  warning: 'Advertencia',
  where: {
    path: (path: string) => `Ubicación: ${path}`,
    line: (line: number) => `Línea ${line} de imsmanifest.xml`,
    value: (value: string) => `Valor: ${value}`,
    limitBytes: (mb: string) => `Límite: ${mb} MB`,
    limitCount: (n: string) => `Límite: ${n}`,
  },
  issuesTruncated: 'Solo se muestran los primeros 200 problemas; los recuentos los incluyen todos.',
  listsTruncated: 'Las listas largas se cortan en 500 entradas; los recuentos lo incluyen todo.',
  libraryLink: 'Revisar un Common Cartridge',
  libraryHint: 'Revisa una exportación de Canvas u otro .imscc antes de una migración (simulación).',
  issues: {
    CARTRIDGE_ARCHIVE_INVALID: 'El archivo no es un archivo ZIP legible.',
    CARTRIDGE_ARCHIVE_TOO_MANY_ENTRIES: 'El archivo comprimido tiene más archivos y carpetas que el límite de revisión.',
    CARTRIDGE_ARCHIVE_TOO_LARGE: 'El archivo comprimido supera el límite de tamaño total al descomprimirse.',
    CARTRIDGE_ARCHIVE_EMPTY: 'El archivo comprimido no contiene archivos.',
    CARTRIDGE_PATH_TRAVERSAL: 'Un nombre de archivo intenta salir de la carpeta del paquete (".."). El paquete no se siguió leyendo.',
    CARTRIDGE_PATH_ABSOLUTE: 'Un nombre de archivo es una ruta absoluta. El paquete no se siguió leyendo.',
    CARTRIDGE_PATH_INVALID: 'Un nombre de archivo no es una ruta válida del paquete.',
    CARTRIDGE_PATH_DUPLICATE: 'Dos archivos tienen el mismo nombre.',
    CARTRIDGE_PATH_COLLISION: 'Dos archivos tienen nombres que solo difieren en mayúsculas o tildes.',
    CARTRIDGE_ENTRY_ENCRYPTED: 'Un archivo está cifrado.',
    CARTRIDGE_ENTRY_SYMLINK: 'Un archivo es un enlace simbólico, lo cual no está permitido.',
    CARTRIDGE_ENTRY_SPECIAL_FILE: 'Una entrada no es un archivo ni una carpeta normal.',
    CARTRIDGE_ENTRY_COMPRESSION_UNSUPPORTED: 'Un archivo usa un método de compresión no admitido.',
    CARTRIDGE_ENTRY_TOO_LARGE: 'Un archivo supera el límite por archivo al descomprimirse.',
    CARTRIDGE_ENTRY_EXPANSION_RATIO: 'Un archivo crece muchísimo más que su tamaño comprimido (posible bomba ZIP).',
    CARTRIDGE_ENTRY_CORRUPT: 'Un archivo está dañado o su tamaño o suma de verificación declarados son incorrectos.',
    CARTRIDGE_MANIFEST_MISSING: 'El paquete no tiene imsmanifest.xml en su raíz.',
    CARTRIDGE_MANIFEST_NESTED: 'imsmanifest.xml está dentro de una carpeta. Exporta o comprime el paquete para que esté en la raíz.',
    CARTRIDGE_MANIFEST_TOO_LARGE: 'imsmanifest.xml supera el límite de revisión.',
    CARTRIDGE_MANIFEST_ENCODING: 'imsmanifest.xml usa una codificación de texto no admitida o no válida.',
    CARTRIDGE_MANIFEST_MALFORMED: 'imsmanifest.xml no es XML bien formado.',
    CARTRIDGE_MANIFEST_DOCTYPE: 'imsmanifest.xml declara un DOCTYPE, que se rechaza por seguridad (las entidades nunca se expanden ni se abren).',
    CARTRIDGE_MANIFEST_TOO_DEEP: 'imsmanifest.xml tiene demasiados niveles de anidación.',
    CARTRIDGE_MANIFEST_TOO_MANY_ELEMENTS: 'imsmanifest.xml tiene demasiados elementos o atributos.',
    CARTRIDGE_MANIFEST_ROOT_INVALID: 'imsmanifest.xml no comienza con un elemento <manifest>.',
    CARTRIDGE_IS_SCORM: 'Es un paquete SCORM, no un Common Cartridge. Usa la revisión SCORM.',
    CARTRIDGE_NOT_CARTRIDGE: 'El manifiesto no declara un IMS Common Cartridge.',
    CARTRIDGE_VERSION_UNSUPPORTED: 'El revisor no admite esta versión de Common Cartridge (se admiten 1.0, 1.1, 1.2 y 1.3). No se leyó como una versión anterior.',
    CARTRIDGE_VERSION_UNDECLARED: 'El manifiesto no indica su versión; se identificó por el espacio de nombres del manifiesto.',
    CARTRIDGE_VERSION_MISMATCH: 'La versión declarada y el espacio de nombres del manifiesto indican versiones distintas; se usó la versión declarada.',
    CARTRIDGE_THIN: 'Es un Thin Common Cartridge: contiene enlaces y herramientas LTI, no contenido del curso.',
    CARTRIDGE_CANVAS_EXTENSIONS: 'El paquete contiene extensiones propias de Canvas que no forman parte del estándar Common Cartridge.',
    CARTRIDGE_ORGANIZATION_MISSING: 'El paquete no tiene esquema del curso (módulos).',
    CARTRIDGE_ORGANIZATION_MULTIPLE: 'El paquete tiene más de un esquema del curso; solo se revisó el primero.',
    CARTRIDGE_ORGANIZATION_NESTED: 'El esquema tiene carpetas dentro de los módulos; las unidades de AcademiaPath tienen un solo nivel, por lo que habría que aplanarlas.',
    CARTRIDGE_ITEM_RESOURCE_MISSING: 'Un elemento del esquema se refiere a un recurso que no existe.',
    CARTRIDGE_RESOURCES_EMPTY: 'El paquete no lista recursos.',
    CARTRIDGE_RESOURCE_IDENTIFIER_MISSING: 'Un recurso no tiene identificador.',
    CARTRIDGE_RESOURCE_IDENTIFIER_DUPLICATE: 'Dos recursos tienen el mismo identificador.',
    CARTRIDGE_RESOURCE_FILE_MISSING: 'Un recurso se refiere a un archivo que no está en el paquete.',
    CARTRIDGE_RESOURCE_HREF_OUTSIDE: 'Una referencia de un recurso sale de la carpeta del paquete.',
    CARTRIDGE_RESOURCE_HREF_DANGEROUS: 'Una referencia de un recurso usa un esquema peligroso (javascript:, data:, file: u otro similar).',
    CARTRIDGE_RESOURCE_HREF_INVALID: 'Una referencia de un recurso no es una ruta válida del paquete.',
    CARTRIDGE_RESOURCE_HREF_EXTERNAL: 'Un recurso que debería estar dentro del paquete apunta a una dirección externa (no se abrió).',
    CARTRIDGE_DEPENDENCY_MISSING: 'Un recurso depende de un recurso que no existe.',
    CARTRIDGE_RESOURCE_TYPE_UNKNOWN: 'Un recurso tiene un tipo que el revisor no reconoce.',
    CARTRIDGE_RESOURCE_INLINE: 'Un recurso describe su contenido dentro del manifiesto; esa descripción no se revisó.',
    CARTRIDGE_DESCRIPTOR_MALFORMED: 'Un archivo de descripción de un recurso no es XML bien formado.',
    CARTRIDGE_DESCRIPTOR_DOCTYPE: 'Un archivo de descripción de un recurso declara un DOCTYPE, que se rechaza por seguridad.',
    CARTRIDGE_DESCRIPTOR_LIMIT: 'Una descripción de recurso o una página supera los límites de revisión y no se leyó.',
    CARTRIDGE_QTI_VERSION_UNSUPPORTED: 'Una evaluación usa una versión de QTI distinta de la 1.2, que el revisor no lee.',
    CARTRIDGE_QUESTION_TYPE_UNSUPPORTED: 'Una evaluación usa tipos de pregunta que los cuestionarios de AcademiaPath no admiten.',
    CARTRIDGE_ASSESSMENT_EMPTY: 'Una evaluación no tiene preguntas.',
    CARTRIDGE_LINK_BROKEN: 'Una página se refiere a un archivo que no está en el paquete.',
    CARTRIDGE_LINK_DANGEROUS: 'Una página o un enlace usa un esquema peligroso (javascript:, data:, file: u otro similar).',
    CARTRIDGE_WEBLINK_INSECURE: 'Un enlace web no usa https; los enlaces de AcademiaPath deben usar https.',
    CARTRIDGE_INSPECTION_FAILED: 'No se pudo revisar el paquete.',
    CARTRIDGE_INSPECTION_LIMIT: 'La revisión del paquete tardó demasiado o necesitó demasiada memoria.',
  },
};

export const cartridge = { en, es };
