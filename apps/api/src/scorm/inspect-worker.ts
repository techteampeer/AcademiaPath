import { parentPort, workerData } from 'node:worker_threads';
import { failureReport, inspectPackage } from './inspect.js';

/**
 * Worker thread entry: inspects one untrusted SCORM package in isolation from the request handlers. The host
 * terminates it on timeout or when it exceeds its heap limit. Network access is disabled, so nothing a package
 * references can make the server fetch a URL; package content is never executed.
 */
const blocked = () => Promise.reject(new Error('Network access is disabled during SCORM inspection.'));
globalThis.fetch = blocked as typeof fetch;

const { bytes, fileName } = workerData as { bytes: ArrayBuffer; fileName: string | null };
const input = Buffer.from(bytes);
const report = await inspectPackage(input, { fileName }).catch(() => failureReport(input, fileName, 'SCORM_INSPECTION_FAILED'));
parentPort?.postMessage(report);
