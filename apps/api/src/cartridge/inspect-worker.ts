import { parentPort, workerData } from 'node:worker_threads';
import { failureReport, inspectCartridge } from './inspect.js';

/** AP-038D: runs one Common Cartridge inspection in an isolated worker (time and heap limits, no network). */
const blocked = () => Promise.reject(new Error('Network access is disabled during Common Cartridge inspection.'));
globalThis.fetch = blocked as typeof fetch;

const { bytes, fileName } = workerData as { bytes: ArrayBuffer; fileName: string | null };
const input = Buffer.from(bytes);
const report = await inspectCartridge(input, { fileName }).catch(() => failureReport(input, fileName, 'CARTRIDGE_INSPECTION_FAILED'));
parentPort?.postMessage(report);
