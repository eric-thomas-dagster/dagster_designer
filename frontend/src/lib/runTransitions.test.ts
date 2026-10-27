import { describe, expect, it } from 'vitest';
import { describeFinishedRun, detectFinishedRuns } from './runTransitions';

const run = (id: string, status: string, job: string | null = 'daily') => ({ run_id: id, status, job_name: job });

describe('detectFinishedRuns', () => {
  it('only records runs it has not seen, so old runs are never announced', () => {
    const seen = new Map<string, string>();
    expect(detectFinishedRuns(seen, [run('a', 'SUCCESS'), run('b', 'FAILURE')])).toEqual([]);
    expect(seen.get('a')).toBe('SUCCESS');
  });
  it('announces a run that finishes after being seen running', () => {
    const seen = new Map<string, string>();
    detectFinishedRuns(seen, [run('a', 'STARTED')]);
    expect(detectFinishedRuns(seen, [run('a', 'FAILURE')])).toEqual([{ runId: 'a', label: 'daily', status: 'FAILURE' }]);
  });
  it('announces each run once', () => {
    const seen = new Map<string, string>();
    detectFinishedRuns(seen, [run('a', 'QUEUED')]);
    detectFinishedRuns(seen, [run('a', 'SUCCESS')]);
    expect(detectFinishedRuns(seen, [run('a', 'SUCCESS')])).toEqual([]);
  });
  it('ignores moves between unfinished states and is case-insensitive', () => {
    const seen = new Map<string, string>();
    detectFinishedRuns(seen, [run('a', 'queued')]);
    expect(detectFinishedRuns(seen, [run('a', 'started')])).toEqual([]);
    expect(detectFinishedRuns(seen, [run('a', 'success')])).toHaveLength(1);
  });
  it('falls back to the pipeline name, then a generic label', () => {
    const seen = new Map<string, string>();
    detectFinishedRuns(seen, [{ run_id: 'a', status: 'STARTED', pipeline_name: 'p' }, { run_id: 'b', status: 'STARTED' }]);
    const out = detectFinishedRuns(seen, [{ run_id: 'a', status: 'SUCCESS', pipeline_name: 'p' }, { run_id: 'b', status: 'CANCELED' }]);
    expect(out.map((r) => r.label)).toEqual(['p', 'Run']);
  });
});

describe('describeFinishedRun', () => {
  it('names the project when given', () => {
    expect(describeFinishedRun({ runId: 'a', label: 'daily', status: 'FAILURE' }, 'Prod')).toEqual({ title: 'Run failed', body: 'daily · Prod' });
    expect(describeFinishedRun({ runId: 'a', label: 'daily', status: 'SUCCESS' }).body).toBe('daily');
  });
});
