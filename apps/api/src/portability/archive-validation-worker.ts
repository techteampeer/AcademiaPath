import { parentPort, workerData } from 'node:worker_threads';
import { transferableCopy } from '../workers/isolated.js';
import { failedValidationReport, readCourseArchive, validateCourseArchive } from './archive-validation.js';

/**
 * AP-038C2C: validates one untrusted course archive in an isolated worker (time and heap limits, no network).
 * AP-038C2E: in `contents` mode (the import), the verified contents leave the worker too: course.json (parsed) and each
 * document file, copied into fresh buffers that are transferred, not copied again, to the API thread.
 */
const blocked = () => Promise.reject(new Error('Network access is disabled during course archive validation.'));
globalThis.fetch = blocked as typeof fetch;

const { bytes, mode } = workerData as { bytes: ArrayBuffer; mode?: 'report' | 'contents' };
const input = Buffer.from(bytes);
if (mode === 'contents') {
  const { report, contents } = await readCourseArchive(input).catch(() => ({ report: failedValidationReport(input.length, 'ARCHIVE_VALIDATION_FAILED'), contents: null }));
  const transfer: ArrayBuffer[] = [];
  const assets = contents
    ? [...contents.assets].map(([key, asset]) => {
        const copy = transferableCopy(asset.bytes);
        transfer.push(copy);
        return { key, format: asset.format, byteSize: asset.byteSize, sha256: asset.sha256, bytes: copy };
      })
    : [];
  parentPort?.postMessage({ report, contents: contents ? { packageJson: contents.packageJson, assets } : null }, transfer);
} else {
  // The preview: only the report leaves the worker; the decompressed files and course.json are discarded with it.
  const report = await validateCourseArchive(input).catch(() => failedValidationReport(input.length, 'ARCHIVE_VALIDATION_FAILED'));
  parentPort?.postMessage(report);
}
