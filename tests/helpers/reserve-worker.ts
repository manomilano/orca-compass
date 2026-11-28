import { readFileSync } from 'node:fs';
import { routeAndReserve } from '../../src/routing/allocate.js';
import type { Config, Environment, RouteRequest } from '../../src/types.js';

// One independent OrcaCompass process of the concurrency test: it waits for the shared start time, routes
// one job on the shared ledger folder and prints the decision.
const [inputFile, dir, startAt] = process.argv.slice(2);
const { env, config, req } = JSON.parse(readFileSync(inputFile, 'utf8')) as { env: Environment; config: Config; req: RouteRequest };
while (Date.now() < Number(startAt)) { /* spin so every process reaches the ledger at the same moment */ }
const d = routeAndReserve(req, env, config, dir);
process.stdout.write(JSON.stringify({ status: d.status, route: d.route ?? null, reservation: d.reservation?.id ?? null, quota: d.quota?.status ?? null }));
