import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readOrcaUsage } from '../../src/routing/orca-usage.js';
import type { Runner, RunResult } from '../../src/system/run.js';

// Synthetic account-list response: no account identities, auth state, or captured usage.
const fixtureText = readFileSync(new URL('../fixtures/orca-account-list.json', import.meta.url), 'utf8');
const fake = (stdout: string, code: number | null = 0): Runner => async () => ({ code, stdout, stderr: '' });
const fixture = () => JSON.parse(fixtureText);
const AGENTS = ['antigravity', 'claude', 'codex', 'cursor', 'grok', 'muse'];
/** The quota identity: a hash of account, runtime and plan, so the ledger holds no account id. */
const SCOPE = expect.stringMatching(/^[0-9a-f]{12}$/);
/** The account: a hash of agent, account id, runtime and distro, without the plan. */
const ACCOUNT = expect.stringMatching(/^[0-9a-f]{12}$/);

describe('readOrcaUsage', () => {
  it('reads the account list with a 20 second timeout', async () => {
    const calls: unknown[] = [];
    const run: Runner = async (...args) => {
      calls.push(args);
      return { code: 0, stdout: fixtureText, stderr: '' };
    };
    await readOrcaUsage(run);
    expect(calls).toEqual([['orca', ['account', 'list', '--json'], { timeoutMs: 20_000 }]]);
  });

  it('maps Claude pools and retains the update timestamp', async () => {
    const usage = await readOrcaUsage(fake(fixtureText));
    expect(usage.claude).toEqual({
      agent: 'claude', status: 'ok', updatedAt: 1793232000000, scope: SCOPE, account: ACCOUNT,
      pools: {
        session: { name: 'session', kind: 'session', usedPercent: 10, windowMinutes: 300, resetsAt: 1793239200000 },
        weekly: { name: 'weekly', kind: 'long', usedPercent: 50, windowMinutes: 10080, resetsAt: 1793282400000 },
        fableWeekly: { name: 'fableWeekly', kind: 'long', usedPercent: 75, windowMinutes: 10080, resetsAt: 1793282400000 },
      },
    });
  });

  it('omits the null Codex session and ignores reset credits', async () => {
    const usage = await readOrcaUsage(fake(fixtureText));
    expect(usage.codex).toEqual({
      agent: 'codex', status: 'ok', updatedAt: 1793232000000, scope: SCOPE, account: ACCOUNT,
      pools: { weekly: { name: 'weekly', kind: 'long', usedPercent: 20, windowMinutes: 10080, resetsAt: 1793736000000 } },
    });
  });

  it('includes a non-null Codex session', async () => {
    const data = fixture();
    data.result.rateLimits.codex.session = data.result.rateLimits.claude.session;
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.codex.pools.session).toEqual({
      name: 'session', kind: 'session', usedPercent: 10, windowMinutes: 300, resetsAt: 1793239200000,
    });
  });

  it('maps Cursor monthly and every named bucket as long pools', async () => {
    const usage = await readOrcaUsage(fake(fixtureText));
    expect(usage.cursor).toEqual({
      agent: 'cursor', status: 'ok', updatedAt: 1793232000000, scope: SCOPE, account: ACCOUNT, source: 'cli',
      pools: {
        monthly: { name: 'monthly', kind: 'long', usedPercent: 2.5, windowMinutes: 44640, resetsAt: 1795132800000 },
        'bucket:Cursor Models': { name: 'bucket:Cursor Models', kind: 'long', usedPercent: 1.25, windowMinutes: 44640, resetsAt: 1795132800000 },
        'bucket:Other Models': { name: 'bucket:Other Models', kind: 'long', usedPercent: 6.25, windowMinutes: 44640, resetsAt: 1795132800000 },
      },
    });
    expect(usage.cursor.pools['bucket:Other Models'].usedPercent).toBeCloseTo(6.25, 2);
    expect(Object.keys(usage).sort()).toEqual(AGENTS);
  });

  it('maps the Grok weekly credit window and monthly budget as long pools', async () => {
    const data = fixture();
    Object.assign(data.result.rateLimits.grok, {
      status: 'ok', error: null,
      weekly: { usedPercent: 30, windowMinutes: 10080, resetsAt: 1793500000000, resetDescription: null },
      monthly: { usedPercent: 12.5, windowMinutes: 43200, resetsAt: 1795000000000, resetDescription: null },
    });
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.grok).toEqual({
      agent: 'grok', status: 'ok', updatedAt: 1793232000000, scope: SCOPE, account: ACCOUNT,
      pools: {
        weekly: { name: 'weekly', kind: 'long', usedPercent: 30, windowMinutes: 10080, resetsAt: 1793500000000 },
        monthly: { name: 'monthly', kind: 'long', usedPercent: 12.5, windowMinutes: 43200, resetsAt: 1795000000000 },
      },
    });
  });

  // Shape of `orca account list --json` for a signed-in agy (Orca 1.4.245, agy 1.4.11); numbers are made up.
  const agyBucket = (group: string, usedPercent: number, windowMinutes: number, resetsAt: number | null, name = group) => ({
    name, group, windowName: windowMinutes === 300 ? '5 Hour Limit Remaining' : 'Weekly Limit Remaining',
    usedPercent, windowMinutes, resetsAt, resetDescription: null,
  });
  const agyUsage = (buckets: unknown[], extra: object = {}) => ({
    provider: 'antigravity', session: null, weekly: { usedPercent: 0, windowMinutes: 10080, resetsAt: 1793800000000, resetDescription: null },
    buckets, updatedAt: 1793232000000, error: null, status: 'ok',
    usageMetadata: { source: 'cli', attemptedSources: ['cli'], lastSuccessfulSource: 'cli', credentialSource: 'antigravity-cli' },
    ...extra,
  });

  it('maps each Antigravity quota group to its own pools, weekly as long and 5-hour as session', async () => {
    const data = fixture();
    data.result.rateLimits.antigravity = agyUsage([
      agyBucket('Gemini Models', 10, 10080, 1793800000000),
      agyBucket('Claude and GPT models', 30, 10080, 1793700000000),
    ]);
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.antigravity).toEqual({
      agent: 'antigravity', status: 'ok', updatedAt: 1793232000000, scope: SCOPE, account: ACCOUNT, source: 'cli',
      pools: {
        'bucket:Gemini Models': { name: 'bucket:Gemini Models', kind: 'long', usedPercent: 10, windowMinutes: 10080, resetsAt: 1793800000000, group: 'Gemini Models' },
        'bucket:Claude and GPT models': { name: 'bucket:Claude and GPT models', kind: 'long', usedPercent: 30, windowMinutes: 10080, resetsAt: 1793700000000, group: 'Claude and GPT models' },
      },
    });

    // A group with both windows: Orca names each bucket "group · window"; the pools key on the group.
    data.result.rateLimits.antigravity = agyUsage([
      agyBucket('Gemini Models', 40, 300, 1793290000000, 'Gemini Models · 5 Hour Limit Remaining'),
      agyBucket('Gemini Models', 10, 10080, 1793800000000, 'Gemini Models · Weekly Limit Remaining'),
      agyBucket('Gemini Models', 15, 10080, 1793800000000, 'Gemini Models · Weekly Limit Remaining'),
      agyBucket('Claude and GPT models', 5, 10080, null),
      { name: 'odd', group: 'Odd', usedPercent: 5, windowMinutes: 0, resetsAt: 1793800000000 },
      null,
    ]);
    const both = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(both.antigravity.pools).toEqual({
      'bucket:Gemini Models 5h': { name: 'bucket:Gemini Models 5h', kind: 'session', usedPercent: 40, windowMinutes: 300, resetsAt: 1793290000000, group: 'Gemini Models' },
      // The tightest of two buckets in the same group and window.
      'bucket:Gemini Models': { name: 'bucket:Gemini Models', kind: 'long', usedPercent: 15, windowMinutes: 10080, resetsAt: 1793800000000, group: 'Gemini Models' },
      // No reset time yet: the window is kept, with no reset time.
      'bucket:Claude and GPT models': { name: 'bucket:Claude and GPT models', kind: 'long', usedPercent: 5, windowMinutes: 10080, resetsAt: null, group: 'Claude and GPT models' },
    });
  });

  it('falls back to Orca\'s overall Antigravity windows when it reports no quota groups', async () => {
    const data = fixture();
    const window = (usedPercent: number, windowMinutes: number, resetsAt: number | null) =>
      ({ usedPercent, windowMinutes, resetsAt, resetDescription: null });
    data.result.rateLimits.antigravity = agyUsage([], { session: window(40, 300, 1793290000000), weekly: window(70, 10080, null) });
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.antigravity.pools).toEqual({
      session: { name: 'session', kind: 'session', usedPercent: 40, windowMinutes: 300, resetsAt: 1793290000000 },
      weekly: { name: 'weekly', kind: 'long', usedPercent: 70, windowMinutes: 10080, resetsAt: null },
    });
  });

  it('keeps Orca\'s unavailable Grok and Antigravity, and Muse without any Orca usage as unknown', async () => {
    const usage = await readOrcaUsage(fake(fixtureText));
    expect(usage.grok).toMatchObject({ status: 'unavailable', pools: {}, error: 'Not signed in to Grok — run grok login' });
    expect(usage.antigravity).toMatchObject({ status: 'unavailable', pools: {}, error: expect.stringMatching(/agy/) });
    expect(usage.muse).toEqual({ agent: 'muse', status: 'unknown', pools: {}, scope: SCOPE, account: ACCOUNT, error: 'Orca reports no usage for muse' });
  });

  it('skips null pools for every provider', async () => {
    const data = fixture();
    Object.assign(data.result.rateLimits.claude, { session: null, weekly: null, fableWeekly: null });
    data.result.rateLimits.codex.weekly = null;
    Object.assign(data.result.rateLimits.cursor, { monthly: null, buckets: [null] });
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    for (const agent of ['claude', 'codex', 'cursor']) expect(usage[agent].pools).toEqual({});
  });

  it('maps provider status unavailable to unavailable with its error', async () => {
    const data = fixture();
    Object.assign(data.result.rateLimits.claude, { status: 'unavailable', error: 'Not signed in' });
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.claude).toMatchObject({ status: 'unavailable', error: 'Not signed in', updatedAt: 1793232000000 });
    expect(usage.codex.status).toBe('ok');
  });

  it.each(['loading', 'stale', undefined])('maps provider status %s to unknown with an error', async (status) => {
    const data = fixture();
    data.result.rateLimits.claude.status = status;
    data.result.rateLimits.claude.error = null;
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.claude).toMatchObject({ status: 'unknown', error: expect.stringMatching(/.+/) });
    expect(usage.codex.status).toBe('ok');
  });

  it('keeps the windows Orca retains after a failed refresh, with their old timestamp and the error', async () => {
    // Orca reports 'error' and keeps its last good windows and their updatedAt: still valid usage, only older.
    const data = fixture();
    Object.assign(data.result.rateLimits.claude, { status: 'error', error: 'Claude usage is unavailable.', updatedAt: 1793231000000 });
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    // Kept windows are older than this read: retained, so they never count as fresh.
    expect(usage.claude).toMatchObject({ status: 'ok', retained: true, updatedAt: 1793231000000, error: 'Claude usage is unavailable.' });
    expect(usage.codex.retained).toBeUndefined();
    expect(usage.claude.pools.weekly.usedPercent).toBe(50);
    // With nothing retained there is no usage: unknown, never an empty 0%.
    Object.assign(data.result.rateLimits.claude, { session: null, weekly: null, fableWeekly: null });
    expect((await readOrcaUsage(fake(JSON.stringify(data)))).claude).toMatchObject({ status: 'unknown', pools: {}, error: 'Claude usage is unavailable.' });
  });

  it('maps a missing provider entry to unknown', async () => {
    const data = fixture();
    delete data.result.rateLimits.cursor;
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.cursor).toEqual({ agent: 'cursor', status: 'unknown', pools: {}, scope: SCOPE, account: ACCOUNT, error: expect.stringMatching(/.+/) });
    expect(usage.claude.status).toBe('ok');
  });

  it('#3 #4 keeps a window with a missing number as unknown, never 0, and a missing reset as no reset', async () => {
    const data = fixture();
    const limits = data.result.rateLimits;
    limits.claude.fableWeekly.usedPercent = null;
    limits.claude.weekly.windowMinutes = 'soon';
    limits.claude.session.resetsAt = undefined;
    limits.codex.weekly.usedPercent = Number.NaN;
    limits.cursor.monthly.usedPercent = -3;
    limits.cursor.buckets[0].name = undefined;
    limits.cursor.buckets[1].name = 42;
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.claude.pools).toEqual({
      session: { name: 'session', kind: 'session', usedPercent: 10, windowMinutes: 300, resetsAt: null },
      weekly: { name: 'weekly', kind: 'long', usedPercent: 50, windowMinutes: null, resetsAt: 1793282400000 },
      fableWeekly: { name: 'fableWeekly', kind: 'long', usedPercent: null, windowMinutes: 10080, resetsAt: 1793282400000 },
    });
    expect(usage.codex.pools.weekly.usedPercent).toBeNull();
    expect(usage.cursor.pools.monthly.usedPercent).toBeNull();
    expect(Object.keys(usage.cursor.pools)).toEqual(['monthly']);
  });

  it('#1 #4 reads a valid 0% as 0, and a reset time of 0 or null as no reset time', async () => {
    // As Orca reports an untouched Claude session and unstarted Antigravity groups.
    const data = fixture();
    data.result.rateLimits.claude.session = { usedPercent: 0, windowMinutes: 300, resetsAt: null, resetDescription: null };
    data.result.rateLimits.antigravity = agyUsage([agyBucket('Claude and GPT models', 0, 10080, 0), agyBucket('Claude and GPT models', 0, 300, 0)]);
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.claude.pools.session).toEqual({ name: 'session', kind: 'session', usedPercent: 0, windowMinutes: 300, resetsAt: null });
    expect(usage.antigravity.pools).toEqual({
      'bucket:Claude and GPT models': { name: 'bucket:Claude and GPT models', kind: 'long', usedPercent: 0, windowMinutes: 10080, resetsAt: null, group: 'Claude and GPT models' },
      'bucket:Claude and GPT models 5h': { name: 'bucket:Claude and GPT models 5h', kind: 'session', usedPercent: 0, windowMinutes: 300, resetsAt: null, group: 'Claude and GPT models' },
    });
    data.result.rateLimits.claude.weekly.usedPercent = 140;
    expect((await readOrcaUsage(fake(JSON.stringify(data)))).claude.pools.weekly.usedPercent).toBe(100);
  });

  it('#29 folds two names of one window into one pool, keeping the tighter known reading', async () => {
    const data = fixture();
    data.result.rateLimits.cursor.buckets = [
      { name: 'Other Models', usedPercent: 6.25, windowMinutes: 44640, resetsAt: 1795132800000 },
      { name: 'other  models', usedPercent: 9, windowMinutes: 44640, resetsAt: 1795132800000 },
      { name: 'OTHER MODELS', usedPercent: null, windowMinutes: 44640, resetsAt: 1795132800000 },
    ];
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(Object.keys(usage.cursor.pools)).toEqual(['monthly', 'bucket:other  models']);
    expect(usage.cursor.pools['bucket:other  models'].usedPercent).toBe(9);
  });

  it('#24 gives each account, runtime and plan its own quota identity, and reports the plan', async () => {
    const scopeOf = async (edit: (result: ReturnType<typeof fixture>['result']) => void, agent = 'claude') => {
      const data = fixture();
      edit(data.result);
      return (await readOrcaUsage(fake(JSON.stringify(data))))[agent];
    };
    const base = await scopeOf(() => {});
    expect(base.scope).toMatch(/^[0-9a-f]{12}$/);
    // Reading the same data again is the same identity.
    expect((await scopeOf(() => {})).scope).toBe(base.scope);
    const plan = await scopeOf((r) => { r.rateLimits.claude.planType = 'max_20x'; });
    expect(plan).toMatchObject({ plan: 'max_20x' });
    const account = await scopeOf((r) => { r.claude = { accounts: [], activeAccountId: 'acct_other' }; });
    const runtime = await scopeOf((r) => { r.rateLimits.claudeTarget = { runtime: 'wsl', wslDistro: 'Ubuntu' }; });
    const provenance = await scopeOf((r) => { r.rateLimits.claude.usageMetadata = { authProvenance: 'managed:acct_other' }; });
    expect(new Set([base.scope, plan.scope, account.scope, runtime.scope, provenance.scope]).size).toBe(5);
    // Another provider's account does not change this one's identity; each provider has its own.
    const codexAccount = await scopeOf((r) => { r.codex = { accounts: [], activeAccountId: null, systemDefault: { providerAccountId: 'acct_codex' } }; });
    expect(codexAccount.scope).toBe(base.scope);
    expect((await scopeOf(() => {}, 'codex')).scope).not.toBe(base.scope);
    // The identity is a hash: no account id leaves Orca.
    expect(JSON.stringify(account)).not.toContain('acct_other');
    // A plan change is another scope of the same account.
    expect(plan.account).toBe(base.account);
    expect(account.account).not.toBe(base.account);
  });

  it('#24 takes the account from the reading itself, else the selection for the target runtime', async () => {
    const read = async (edit: (result: ReturnType<typeof fixture>['result']) => void) => {
      const data = fixture();
      edit(data.result);
      return (await readOrcaUsage(fake(JSON.stringify(data)))).claude;
    };
    const host = await read((r) => { r.claude = { activeAccountId: 'acct_a', activeAccountIdsByRuntime: { host: 'acct_a', wsl: { Ubuntu: 'acct_b' } } }; });
    // The account the reading names wins over the host selection.
    const reading = await read((r) => {
      r.claude = { activeAccountId: 'acct_a', activeAccountIdsByRuntime: { host: 'acct_a', wsl: { Ubuntu: 'acct_b' } } };
      r.rateLimits.claude.usageMetadata = { readingAccount: { accountId: 'acct_b', runtime: 'wsl', wslDistro: 'Ubuntu' } };
    });
    expect(reading.account).not.toBe(host.account);
    // A WSL target uses that distro's selection, compared case-insensitively, and matches the reading's account.
    const wsl = await read((r) => {
      r.claude = { activeAccountId: 'acct_a', activeAccountIdsByRuntime: { host: 'acct_a', wsl: { Ubuntu: 'acct_b' } } };
      r.rateLimits.claudeTarget = { runtime: 'wsl', wslDistro: 'ubuntu' };
    });
    expect(wsl.account).not.toBe(host.account);
    expect(wsl.account).toBe(reading.account);
    // The host selection and the legacy activeAccountId name the same account.
    const legacy = await read((r) => { r.claude = { activeAccountId: 'acct_a' }; });
    expect(legacy.account).toBe(host.account);
    // Every status carries the account, and no account id leaves Orca.
    const signedOut = await read((r) => {
      r.claude = { activeAccountId: 'acct_a' };
      Object.assign(r.rateLimits.claude, { status: 'unavailable', error: 'Not signed in' });
    });
    expect(signedOut).toMatchObject({ status: 'unavailable', account: host.account });
    for (const u of [host, reading, wsl, signedOut]) expect(JSON.stringify(u)).not.toMatch(/acct_/);
  });

  it('#7 reads a monthly-only Claude account', async () => {
    const data = fixture();
    Object.assign(data.result.rateLimits.claude, {
      session: null, weekly: null, fableWeekly: null,
      monthly: { usedPercent: 100, windowMinutes: 43200, resetsAt: 1795000000000, resetDescription: null },
    });
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.claude).toMatchObject({
      status: 'ok', pools: { monthly: { name: 'monthly', kind: 'long', usedPercent: 100, windowMinutes: 43200, resetsAt: 1795000000000 } },
    });
    expect(Object.keys(usage.claude.pools)).toEqual(['monthly']);
  });

  it('#7 trims bucket names and skips empty ones', async () => {
    const data = fixture();
    data.result.rateLimits.cursor.buckets = [
      { name: '  Other Models ', usedPercent: 6.25, windowMinutes: 44640, resetsAt: 1795132800000 },
      { name: '   ', usedPercent: 50, windowMinutes: 44640, resetsAt: 1795132800000 },
      { name: '', usedPercent: 50, windowMinutes: 44640, resetsAt: 1795132800000 },
    ];
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(Object.keys(usage.cursor.pools)).toEqual(['monthly', 'bucket:Other Models']);
  });

  it('#7 keeps each Antigravity window length of a group apart, every one tagged with its group', async () => {
    const data = fixture();
    data.result.rateLimits.antigravity = agyUsage([
      agyBucket(' Gemini Models ', 40, 300, 1793290000000),
      agyBucket('Gemini Models', 90, 1440, 1793300000000),
      agyBucket('Gemini Models', 10, 10080, 1793800000000),
    ]);
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.antigravity.pools).toEqual({
      'bucket:Gemini Models 5h': { name: 'bucket:Gemini Models 5h', kind: 'session', usedPercent: 40, windowMinutes: 300, resetsAt: 1793290000000, group: 'Gemini Models' },
      'bucket:Gemini Models 1d': { name: 'bucket:Gemini Models 1d', kind: 'long', usedPercent: 90, windowMinutes: 1440, resetsAt: 1793300000000, group: 'Gemini Models' },
      'bucket:Gemini Models': { name: 'bucket:Gemini Models', kind: 'long', usedPercent: 10, windowMinutes: 10080, resetsAt: 1793800000000, group: 'Gemini Models' },
    });
  });

  it('#7 ignores OpenCode Go: it is not read until its models are mapped', async () => {
    const data = fixture();
    const before = await readOrcaUsage(fake(JSON.stringify(data)));
    data.result.rateLimits.opencodeGo = {
      provider: 'opencode-go', status: 'ok', updatedAt: 1793232000000, error: null,
      session: { usedPercent: 99, windowMinutes: 300, resetsAt: 1793239200000 }, weekly: { usedPercent: 99, windowMinutes: 10080, resetsAt: 1793282400000 }, monthly: null,
    };
    const after = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(after).toEqual(before);
    expect(Object.keys(after)).not.toContain('opencode');
  });

  it('#9 reads each agent on its own: a malformed bucket list leaves the others readable', async () => {
    const data = fixture();
    data.result.rateLimits.cursor.buckets = { a: 1 };
    data.result.rateLimits.antigravity = agyUsage([], { buckets: 5 });
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.claude.status).toBe('ok');
    expect(usage.codex.status).toBe('ok');
    expect(usage.cursor).toMatchObject({ status: 'ok', pools: { monthly: { usedPercent: 2.5 } } });
    expect(Object.keys(usage.cursor.pools)).toEqual(['monthly']);
    expect(usage.antigravity).toMatchObject({ status: 'ok', pools: { weekly: { usedPercent: 0 } } });
  });

  it('reports where the reading came from', async () => {
    const data = fixture();
    data.result.rateLimits.claude.usageMetadata = { source: 'live-session' };
    expect((await readOrcaUsage(fake(JSON.stringify(data)))).claude.source).toBe('live-session');
  });

  it('provides an error when an unavailable provider supplies none', async () => {
    const data = fixture();
    data.result.rateLimits.cursor.status = 'unavailable';
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.cursor.status).toBe('unavailable');
    expect(usage.cursor.error).toEqual(expect.any(String));
    expect(usage.cursor.error?.length).toBeGreaterThan(0);
  });

  it.each<[string, RunResult, string]>([
    ['missing executable', { code: null, stdout: '', stderr: '', error: 'ENOENT' }, 'ENOENT'],
    ['timeout', { code: null, stdout: '', stderr: '', error: 'timed out after 20000 ms' }, 'timed out'],
    ['nonzero exit', { code: 1, stdout: fixtureText, stderr: 'runtime offline' }, 'runtime offline'],
    ['runner error despite zero exit', { code: 0, stdout: fixtureText, stderr: '', error: 'read failed' }, 'read failed'],
    ['non-JSON', { code: 0, stdout: 'not json', stderr: '' }, ''],
    ['API failure', { code: 0, stdout: JSON.stringify({ ok: false, error: 'runtime unavailable' }), stderr: '' }, 'runtime unavailable'],
    ['missing rate limits', { code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: '' }, ''],
  ])('returns unknown usage for all agents on %s', async (_name, result, reason) => {
    const usage = await readOrcaUsage(async () => result);
    expect(Object.keys(usage).sort()).toEqual(AGENTS);
    for (const agent of AGENTS) {
      // Unknown, with no pools: a failed read is never an empty 0% (#23).
      expect(usage[agent]).toEqual({ agent, status: 'unknown', pools: {}, error: expect.stringMatching(/^Orca not reachable: .+/), unreachable: true });
      expect(usage[agent].error).toContain(reason);
    }
  });
});
