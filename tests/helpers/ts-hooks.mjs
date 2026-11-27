import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Lets a plain `node` child process run the TypeScript sources: the sources import `./x.js`, which Node's
// own type stripping does not map to `./x.ts`.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (existsSync(fileURLToPath(ts))) return nextResolve(ts.href, context);
  }
  return nextResolve(specifier, context);
}
