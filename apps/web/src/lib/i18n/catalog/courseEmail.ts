// Composing an e-mail to a course's students in one's own e-mail application (AP-044). AcademiaPath never sends it.

const en = {
  title: 'Compose email to students',
  action: 'Compose email to students',
  navLabel: 'Email students',
  loading: 'Loading the class list…',
  intro:
    'Write one email to the active students of this course. AcademiaPath does not send it: “Open email application” opens a new message in the email application of this device, where you review it and send it yourself.',
  internal: 'To reach students inside AcademiaPath, use course announcements or course messages.',
  forbidden: 'Only instructors of this course and administrators can email its students.',
  notFound: 'This course is not available.',
  recipients: {
    heading: 'Recipients',
    count: (n: number) => (n === 1 ? '1 active student will be in BCC.' : `${n} active students will be in BCC.`),
    none: 'This course has no active students with an email address, so there is nobody to email.',
    invalid: (n: number) =>
      n === 1 ? '1 active student has no valid email address and is not included.' : `${n} active students have no valid email address and are not included.`,
    duplicate: (n: number) => (n === 1 ? '1 repeated address is included only once.' : `${n} repeated addresses are included only once.`),
    show: 'Show the recipients',
    privacy: 'Students are placed in BCC, so they do not see each other’s addresses. Your own address is placed in To, and nobody is placed in CC.',
  },
  message: {
    heading: 'Subject and message',
    subject: 'Subject',
    body: 'Message',
    bodyHint: 'Plain text. You can still edit and format it in your email application.',
  },
  send: {
    heading: 'Open in your email application',
    open: 'Open email application',
    copyBcc: 'Copy BCC addresses',
    copyMessage: 'Copy message',
    showAddresses: 'Show the addresses to copy',
    hideAddresses: 'Hide the addresses',
    addressesLabel: 'BCC addresses',
    behaviour: 'Your email application opens with a new message. Check it, then send it from there. AcademiaPath does not know or record whether it was sent.',
    longList:
      'This class has too many addresses to pass to every email application in one link. Copy the BCC addresses and paste them into the BCC field of the new message. The button opens the message with your subject and text.',
    longMessage:
      'The message is too long to pass to the email application in a link. Copy the BCC addresses and the message, then paste them into the new message. The button opens it with your subject.',
    providerLimit: 'Email providers may limit how many recipients one message can have. If yours refuses the message, send it in smaller groups.',
    noClient: 'If nothing opens, this device has no default email application. Copy the BCC addresses and paste them into a new message in your email.',
    opened: 'Your email application should now show a new message. Nothing has been sent yet: review it and send it from your email application.',
    bccCopied: 'BCC addresses copied. Paste them into the BCC field of the new message.',
    messageCopied: 'Message copied. Paste it into the new message.',
    copyFailed: 'Copying is not available here. Select the addresses below and copy them.',
  },
};

export type CourseEmailMessages = typeof en;

const es: CourseEmailMessages = {
  title: 'Redactar correo a los estudiantes',
  action: 'Redactar correo a los estudiantes',
  navLabel: 'Correo a estudiantes',
  loading: 'Cargando la lista de la clase…',
  intro:
    'Escribe un correo para los estudiantes activos de este curso. AcademiaPath no lo envía: «Abrir aplicación de correo» abre un mensaje nuevo en la aplicación de correo de este dispositivo, donde lo revisas y lo envías tú.',
  internal: 'Para comunicarte con los estudiantes dentro de AcademiaPath, usa los anuncios o los mensajes del curso.',
  forbidden: 'Solo los docentes de este curso y los administradores pueden enviar correos a sus estudiantes.',
  notFound: 'Este curso no está disponible.',
  recipients: {
    heading: 'Destinatarios',
    count: (n: number) => (n === 1 ? '1 estudiante activo irá en CCO.' : `${n} estudiantes activos irán en CCO.`),
    none: 'Este curso no tiene estudiantes activos con correo electrónico, así que no hay a quién escribir.',
    invalid: (n: number) =>
      n === 1
        ? '1 estudiante activo no tiene un correo válido y no se incluye.'
        : `${n} estudiantes activos no tienen un correo válido y no se incluyen.`,
    duplicate: (n: number) => (n === 1 ? '1 dirección repetida se incluye una sola vez.' : `${n} direcciones repetidas se incluyen una sola vez.`),
    show: 'Ver los destinatarios',
    privacy: 'Los estudiantes van en CCO, así que no ven las direcciones de los demás. Tu propia dirección va en Para y nadie va en CC.',
  },
  message: {
    heading: 'Asunto y mensaje',
    subject: 'Asunto',
    body: 'Mensaje',
    bodyHint: 'Texto sin formato. Aún puedes editarlo y darle formato en tu aplicación de correo.',
  },
  send: {
    heading: 'Abrir en tu aplicación de correo',
    open: 'Abrir aplicación de correo',
    copyBcc: 'Copiar direcciones CCO',
    copyMessage: 'Copiar mensaje',
    showAddresses: 'Ver las direcciones para copiar',
    hideAddresses: 'Ocultar las direcciones',
    addressesLabel: 'Direcciones CCO',
    behaviour: 'Tu aplicación de correo se abre con un mensaje nuevo. Revísalo y envíalo desde allí. AcademiaPath no sabe ni registra si se envió.',
    longList:
      'Esta clase tiene demasiadas direcciones para pasarlas a todas las aplicaciones de correo en un solo enlace. Copia las direcciones CCO y pégalas en el campo CCO del mensaje nuevo. El botón abre el mensaje con tu asunto y tu texto.',
    longMessage:
      'El mensaje es demasiado largo para pasarlo a la aplicación de correo en un enlace. Copia las direcciones CCO y el mensaje, y pégalos en el mensaje nuevo. El botón lo abre con tu asunto.',
    providerLimit: 'Los proveedores de correo pueden limitar cuántos destinatarios admite un mensaje. Si el tuyo lo rechaza, envíalo en grupos más pequeños.',
    noClient: 'Si no se abre nada, este dispositivo no tiene una aplicación de correo predeterminada. Copia las direcciones CCO y pégalas en un mensaje nuevo de tu correo.',
    opened: 'Tu aplicación de correo debería mostrar ahora un mensaje nuevo. Todavía no se ha enviado nada: revísalo y envíalo desde tu aplicación de correo.',
    bccCopied: 'Direcciones CCO copiadas. Pégalas en el campo CCO del mensaje nuevo.',
    messageCopied: 'Mensaje copiado. Pégalo en el mensaje nuevo.',
    copyFailed: 'Aquí no se puede copiar. Selecciona las direcciones de abajo y cópialas.',
  },
};

export const courseEmail = { en, es };
