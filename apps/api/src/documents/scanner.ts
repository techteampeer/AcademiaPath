import type { DocumentFormat } from '../db/schema/index.js';

export type MalwareScanResult = { status: 'not_scanned' | 'clean' | 'infected'; scanner: string };

/**
 * Malware scanning hook, called for every upload before the file is parsed or stored. A real scanner
 * (for example a ClamAV daemon or a cloud scanning service) can implement this later; an `infected`
 * result rejects the upload.
 */
export interface MalwareScanner {
  scan(bytes: Uint8Array, file: { fileName: string; format: DocumentFormat }): Promise<MalwareScanResult>;
}

/**
 * Default: NO production malware scanning service is connected. Uploads are recorded as
 * `not_scanned`. This local proof of concept is not approved for untrusted production documents.
 */
export const noMalwareScanner: MalwareScanner = {
  async scan() {
    return { status: 'not_scanned', scanner: 'none' };
  },
};
