// Loader de Node: redirige 'stripe' y '@aws-sdk/*' a los stubs del test.
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const map = {
  stripe: './stubs/stripe.mjs',
  '@aws-sdk/client-dynamodb': './stubs/ddb.mjs',
  '@aws-sdk/lib-dynamodb': './stubs/ddb.mjs',
};

export async function resolve(specifier, context, next) {
  if (map[specifier]) {
    return { url: pathToFileURL(path.join(here, map[specifier])).href, shortCircuit: true };
  }
  return next(specifier, context);
}
