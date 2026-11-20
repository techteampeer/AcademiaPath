import { parentPort, workerData } from 'node:worker_threads';
import { failedValidationReport, validateCourseArchive } from './archive-validation.js';

/** AP-038C2C: validates one untrusted course archive in an isolated worker (time and heap limits, no network). */
const blocked = () => Promise.reject(new Error('Network access is disabled during course archive validation.'));
globalThis.fetch = blocked as typeof fetch;

const { bytes } = workerData as { bytes: ArrayBuffer };
const input = Buffer.from(bytes);
// Only the report leaves the worker: the decompressed files and course.json stay here and are discarded with it.
const report = await validateCourseArchive(input).catch(() => failedValidationReport(input.length, 'ARCHIVE_VALIDATION_FAILED'));
parentPort?.postMessage(report);
