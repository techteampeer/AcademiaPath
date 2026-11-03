import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';

const specPath = fileURLToPath(new URL('../openapi.yaml', import.meta.url));

try {
  const api = await SwaggerParser.validate(specPath);
  if (!api.openapi?.startsWith('3.1.')) {
    throw new Error(`Expected OpenAPI 3.1.x, found ${api.openapi}`);
  }
  console.log(`OpenAPI ${api.openapi} spec is valid: ${api.info.title} v${api.info.version}`);
} catch (err) {
  console.error(`OpenAPI validation failed: ${err.message}`);
  process.exit(1);
}
