/** Development preview of the reusable course components (/preview/courses), shown with frontend sample data. */
const en = {
  badge: 'Demonstration data',
  title: 'Course components preview',
  intro: 'Reusable course and student progress components, shown with synthetic sample data.',
  noteTitle: 'These courses are synthetic demonstration data.',
  noteBody:
    'They are defined in the frontend for preview purposes only and are not loaded from the AcademiaPath API or database. Instructor names and progress values are fictional.',
  gridTitle: 'Course grid',
  gridIntro: 'Sample courses covering each course status and progress at 0%, partial and 100%.',
  emptyTitle: 'Empty state',
  emptyIntro: 'How the course grid appears when there are no courses to display.',
  // Shared course components
  noCourses: 'No courses to show',
  noCoursesDescription: 'Courses will appear here once they are available.',
  instructor: 'Instructor',
  progress: 'Progress',
};

export type PreviewMessages = typeof en;

const es: PreviewMessages = {
  badge: 'Datos de demostración',
  title: 'Vista previa de componentes de cursos',
  intro: 'Componentes reutilizables de cursos y de avance de estudiantes, mostrados con datos de ejemplo sintéticos.',
  noteTitle: 'Estos cursos son datos de demostración sintéticos.',
  noteBody:
    'Se definen en la interfaz solo para esta vista previa y no se cargan desde la API ni la base de datos de AcademiaPath. Los nombres de docentes y los valores de avance son ficticios.',
  gridTitle: 'Cuadrícula de cursos',
  gridIntro: 'Cursos de ejemplo con cada estado de curso y avances de 0 %, parcial y 100 %.',
  emptyTitle: 'Estado vacío',
  emptyIntro: 'Cómo se ve la cuadrícula de cursos cuando no hay cursos para mostrar.',
  noCourses: 'No hay cursos para mostrar',
  noCoursesDescription: 'Los cursos aparecerán aquí cuando estén disponibles.',
  instructor: 'Docente',
  progress: 'Avance',
};

export const preview = { en, es };
