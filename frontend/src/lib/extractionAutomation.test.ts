import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWatchAutomation, installAndConfigure } from './extractionAutomation';

type Call = { url: string; body: any };

function stubFetch(respond: (url: string) => { ok: boolean; status?: number; json?: any }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const r = respond(String(url));
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.json ?? {} };
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('installAndConfigure', () => {
  it('installs the component template, then configures the instance', async () => {
    const calls = stubFetch(() => ({ ok: true }));
    await installAndConfigure('p1', 'asset_job', { name: 'j' });
    expect(calls.map((c) => c.url.split('/templates/')[1])).toEqual(['install-via-cli/asset_job', 'configure/asset_job']);
    expect(calls[0].body).toEqual({ project_id: 'p1', config: {}, template_only: true });
    expect(calls[1].body).toEqual({ project_id: 'p1', config: { name: 'j' } });
  });
  it('surfaces the server message and stops at the first failure', async () => {
    const calls = stubFetch((url) => (url.includes('install-via-cli') ? { ok: false, json: { detail: 'registry unreachable' } } : { ok: true }));
    await expect(installAndConfigure('p1', 'asset_job', {})).rejects.toThrow("Couldn't add asset_job: registry unreachable");
    expect(calls).toHaveLength(1);
  });
  it('reads a structured detail message, and falls back to the status', async () => {
    stubFetch(() => ({ ok: false, status: 409, json: { detail: { message: 'name taken' } } }));
    await expect(installAndConfigure('p1', 'x', {})).rejects.toThrow('name taken');
    stubFetch(() => ({ ok: false, status: 502 }));
    await expect(installAndConfigure('p1', 'x', {})).rejects.toThrow('HTTP 502');
  });
});

describe('createWatchAutomation', () => {
  const settings = { assetName: 'invoice_fields', directory: '/data/invoices', pattern: '(?i).*\\.pdf$', intervalSeconds: 60 };

  it('creates the job first, then a sensor that points at it and starts running', async () => {
    const calls = stubFetch(() => ({ ok: true }));
    const names = await createWatchAutomation('p1', settings);
    expect(names).toEqual({ job: 'invoice_fields_job', sensor: 'invoice_fields_new_files' });
    expect(calls.map((c) => c.url.split('/templates/')[1])).toEqual([
      'install-via-cli/asset_job', 'configure/asset_job', 'install-via-cli/filesystem_monitor', 'configure/filesystem_monitor',
    ]);
    expect(calls[1].body.config).toEqual({ name: 'invoice_fields_job', job_name: 'invoice_fields_job', asset_keys: ['invoice_fields'] });
    expect(calls[3].body.config).toEqual({
      name: 'invoice_fields_new_files', sensor_name: 'invoice_fields_new_files', directory_path: '/data/invoices',
      file_pattern: '(?i).*\\.pdf$', job_name: 'invoice_fields_job', minimum_interval_seconds: 60, default_status: 'running',
    });
  });
  it('never polls faster than every 5 seconds', async () => {
    const calls = stubFetch(() => ({ ok: true }));
    await createWatchAutomation('p1', { ...settings, intervalSeconds: 1 });
    expect(calls[3].body.config.minimum_interval_seconds).toBe(5);
  });
  it('does not create the sensor when the job failed', async () => {
    const calls = stubFetch((url) => (url.includes('configure/asset_job') ? { ok: false, json: { detail: 'bad job' } } : { ok: true }));
    await expect(createWatchAutomation('p1', settings)).rejects.toThrow('bad job');
    expect(calls.some((c) => c.url.includes('filesystem_monitor'))).toBe(false);
  });
});
