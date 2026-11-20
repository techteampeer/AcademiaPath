import { randomUUID } from 'node:crypto';
import { assignmentFromInput } from '../assignments/model.js';
import type { Database } from '../db/client.js';
import { activities, quizQuestions, resourceFolders, sectionPrerequisites, sections, type ActivityConfig } from '../db/schema/index.js';
import type { DocumentConfig } from '../documents/model.js';
import { buildQuestion } from '../quizzes/model.js';
import type { ImportPlan } from './course-import.js';

/**
 * Writes the document row (and its summary) of a restored document activity, inside the import transaction, after the
 * activity exists. AP-038C2B archive import only: the JSON import (AP-038B) never plans a document.
 */
export type DocumentRestorer = (
  tx: Pick<Database, 'insert'>,
  target: {
    activityKey: string;
    activityId: string;
    documentId: string;
    summaryId: string;
    assetKey: string;
    fileName: string;
  },
) => Promise<void>;

/**
 * Creates the planned content under a new course with fresh identifiers, mapping each package key to the new row:
 * units in order, prerequisites, folders, then activities as drafts (never approved: they go through this
 * institution's review), quiz questions with new option ids and remapped answer keys, rubrics with new criterion ids,
 * and assignments with the due date chosen at import (no late window).
 */
export async function reconstructCourse(tx: Pick<Database, 'insert'>, courseId: string, plan: ImportPlan, userId: string, assignmentDueAt: string | null, restoreDocument?: DocumentRestorer) {
  const created = {
    units: 0,
    folders: 0,
    prerequisites: 0,
    activities: 0,
    questions: 0,
    documents: 0,
  };
  const unitIds = new Map<string, string>();
  for (const [position, unit] of plan.units.entries()) {
    const [row] = await tx
      .insert(sections)
      .values({
        courseId,
        title: unit.title,
        summary: unit.summary,
        position,
        isVisible: unit.visible,
      })
      .returning({ id: sections.id });
    unitIds.set(unit.key, row!.id);
    created.units += 1;
  }
  for (const unit of plan.units) {
    if (!unit.requiresUnitKeys.length) continue;
    await tx.insert(sectionPrerequisites).values(
      unit.requiresUnitKeys.map((key) => ({
        courseId,
        sectionId: unitIds.get(unit.key)!,
        requiredSectionId: unitIds.get(key)!,
        createdByUserId: userId,
      })),
    );
    created.prerequisites += unit.requiresUnitKeys.length;
  }
  for (const unit of plan.units) {
    const sectionId = unitIds.get(unit.key)!;
    const folderIds = new Map<string, string>();
    for (const [position, folder] of unit.folders.entries()) {
      const [row] = await tx
        .insert(resourceFolders)
        .values({
          courseId,
          sectionId,
          title: folder.title,
          position,
          createdByUserId: userId,
        })
        .returning({ id: resourceFolders.id });
      folderIds.set(folder.key, row!.id);
      created.folders += 1;
    }
    for (const [position, activity] of unit.activities.entries()) {
      let config: ActivityConfig;
      // A bundled document: new document and summary ids, the row itself written by the restorer after the activity.
      const document = activity.document
        ? {
            documentId: randomUUID(),
            summaryId: randomUUID(),
            ...activity.document,
          }
        : null;
      if (document) {
        if (!restoreDocument) throw new Error(`Unplanned document activity ${activity.key}`);
        config = {
          documentId: document.documentId,
          summaryId: document.summaryId,
          summaryRevision: 1,
          fileName: document.fileName,
          format: document.format,
        } satisfies DocumentConfig;
      } else if (activity.page) config = { body: activity.page.body };
      else if (activity.link)
        config = {
          url: activity.link.url,
          description: activity.link.description,
          kind: activity.link.kind,
        };
      else if (activity.quiz) config = { ...activity.quiz.settings };
      else if (activity.assignment) {
        config = assignmentFromInput({
          title: activity.title,
          instructions: activity.assignment.instructions,
          dueAt: assignmentDueAt!,
          lateUntil: null,
          rubric: activity.assignment.rubric.map((c) => ({
            title: c.title,
            ...(c.description ? { description: c.description } : {}),
            maxPoints: c.maxPoints,
          })),
        });
      } else throw new Error(`Unplanned activity ${activity.key}`);
      const [row] = await tx
        .insert(activities)
        .values({
          sectionId,
          type: activity.type,
          title: activity.title,
          position,
          isVisible: activity.visible,
          config,
          reviewStatus: 'draft',
          folderId: activity.folderKey ? folderIds.get(activity.folderKey)! : null,
        })
        .returning({ id: activities.id });
      created.activities += 1;
      if (document) {
        await restoreDocument!(tx, {
          activityKey: activity.key,
          activityId: row!.id,
          documentId: document.documentId,
          summaryId: document.summaryId,
          assetKey: document.assetKey,
          fileName: document.fileName,
        });
        created.documents += 1;
      }
      if (activity.quiz?.questions.length) {
        // buildQuestion makes fresh option ids and the answer key from them, exactly as when staff add a question.
        await tx.insert(quizQuestions).values(
          activity.quiz.questions.map((input, index) => ({
            activityId: row!.id,
            position: index,
            ...buildQuestion(input),
          })),
        );
        created.questions += activity.quiz.questions.length;
      }
    }
  }
  // The JSON import's counts (and its audit record) stay exactly as before: `documents` only when documents are restored.
  const { documents, ...withoutDocuments } = created;
  return restoreDocument ? created : withoutDocuments;
}
