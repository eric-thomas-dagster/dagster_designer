import { describe, it, expect } from 'vitest';
import { extractMaterializeErrorMessage } from './materializeError';

// A trimmed but structurally real capture of `dg launch`'s stdout for a
// failed dbt model -- confirmed live against project_abf9a8c9_adsfasd.
// dbt colors the "Failure in model" header, so the ANSI codes here are
// real, not decorative -- that's exactly what broke the naive version of
// this extraction (the `^failure in` anchor didn't match a line that
// actually started with `\x1b[31m`).
const REAL_DBT_STDOUT = [
  'Running with dbt=1.11.7',
  '2 of 19 START sql view model main_staging.stg_ticket_sales .... [RUN]',
  '2 of 19 ERROR creating sql view model main_staging.stg_ticket_sales',
  '',
  'Finished running 1 table model, 16 data tests, 2 view models in 0.22s.',
  '',
  '\x1b[31mCompleted with 1 error, 0 partial successes, and 0 warnings:\x1b[0m',
  '',
  '\x1b[31mFailure in model stg_ticket_sales (models/staging/stg_ticket_sales.sql)\x1b[0m',
  '  Runtime Error in model stg_ticket_sales (models/staging/stg_ticket_sales.sql)',
  '  Catalog Error: Table with name ticketmaster_transactions does not exist!',
  '  Did you mean "information_schema.referential_constraints"?',
  '  ',
  '  LINE 6:     select * from "demo_warehouse"."raw"."ticketmaster_transactions"',
  '                            ^',
  '',
  '  compiled code at target/chicago_bulls/models/staging/stg_ticket_sales.sql',
  '',
  'Done. PASS=6 WARN=0 ERROR=1 SKIP=12 NO-OP=0 TOTAL=19',
].join('\n');

// Dagster's own orchestration stderr for the same failed run -- real,
// but generic: no mention of WHY the run failed, just that it did.
const DAGSTER_STDERR = [
  '  File ".../execute_step.py", line 184, in _step_output_error_checked_user_event_sequence',
  '    self._raise_on_error()',
  '  File ".../dbt_cli_invocation.py", line 470, in _raise_on_error',
  '    raise error',
  '2026-09-25 13:48:28 -0400 - dagster - ERROR - __ASSET_JOB - ... - RUN_FAILURE - Execution of run for "__ASSET_JOB" failed. Steps failed: [\'chicago_bulls\'].',
  'Error: Materialization failed.',
].join('\n');

describe('extractMaterializeErrorMessage', () => {
  it('prefers dbt\'s own Failure-in-model block over generic dagster stderr', () => {
    const message = extractMaterializeErrorMessage(REAL_DBT_STDOUT, DAGSTER_STDERR);
    expect(message).toContain('Failure in model stg_ticket_sales');
    expect(message).toContain('Catalog Error: Table with name ticketmaster_transactions does not exist!');
  });

  it('strips ANSI color codes from the extracted message', () => {
    const message = extractMaterializeErrorMessage(REAL_DBT_STDOUT, DAGSTER_STDERR);
    expect(message).not.toMatch(/\x1b\[/);
  });

  it('does not include the generic dagster stack-trace noise when a dbt block is present', () => {
    const message = extractMaterializeErrorMessage(REAL_DBT_STDOUT, DAGSTER_STDERR);
    expect(message).not.toContain('_raise_on_error');
    expect(message).not.toContain('RUN_FAILURE');
  });

  it('falls back to stderr/stdout keyword scanning when there is no dbt failure marker', () => {
    // A non-dbt component's failure -- no "Failure in model" line exists
    // anywhere, so this must fall back gracefully instead of returning
    // nothing.
    const stdout = 'Running asset...\n';
    const stderr = [
      '2026-01-01 ERROR something else went wrong',
      'Traceback (most recent call last):',
      'ValueError: bad config',
    ].join('\n');
    const message = extractMaterializeErrorMessage(stdout, stderr);
    expect(message).toContain('bad config');
  });

  it('returns "unknown error" when neither stream has anything useful', () => {
    const message = extractMaterializeErrorMessage('', '');
    expect(message).toBe('unknown error');
  });

  it('handles undefined stdout/stderr without throwing', () => {
    expect(() => extractMaterializeErrorMessage(undefined, undefined)).not.toThrow();
  });
});
