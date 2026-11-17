/** node:sqlite (Node 22.13+, where it needs no flag) without its one-time ExperimentalWarning on stderr. */
export async function importSqlite(): Promise<typeof import('node:sqlite')> {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning instanceof Error ? warning.message : warning).includes('SQLite')) return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import('node:sqlite');
  } catch {
    throw new Error(`this Node.js (${process.version}) has no node:sqlite; Node 22.13 or later is needed`);
  } finally {
    process.emitWarning = emitWarning;
  }
}
