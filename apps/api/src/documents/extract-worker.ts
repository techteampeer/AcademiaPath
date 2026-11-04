import { parentPort, workerData } from 'node:worker_threads';
import type { DocumentFormat } from '../db/schema/index.js';
import { extractDocument } from './extract.js';

/**
 * Worker thread entry: parses one untrusted document in isolation from the request handlers. The
 * host terminates it on timeout or when it exceeds its heap limit. Network access is disabled here so
 * nothing inside a document can make the server fetch a URL.
 */
const blocked = () => Promise.reject(new Error('Network access is disabled during document extraction.'));
globalThis.fetch = blocked as typeof fetch;

const { bytes, expected } = workerData as { bytes: ArrayBuffer; expected: DocumentFormat };
const outcome = await extractDocument(new Uint8Array(bytes), expected);
parentPort?.postMessage(outcome);
