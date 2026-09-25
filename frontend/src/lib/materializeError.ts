/**
 * Extracts the most useful error message from a failed `dg launch` /
 * materialize subprocess's captured stdout+stderr.
 *
 * dbt's own per-model failure block ("Failure in model X ... Catalog
 * Error: ...") -- by far the most actionable text available -- lives in
 * STDOUT. Dagster's own orchestration logging (RUN_FAILURE,
 * _raise_on_error stack frames) lives in STDERR and is real but far less
 * useful: generic Python frames, never the actual reason the run failed.
 * An earlier version of this logic did `(stderr || stdout || '')`, which
 * picks stderr whenever it's non-empty -- always true for a failed run --
 * so stdout's actual dbt error never got shown at all. Confirmed live: a
 * real "Catalog Error: table does not exist" was sitting right there in
 * stdout while the UI showed only opaque dagster internals.
 */
export function extractMaterializeErrorMessage(stdout: string | undefined, stderr: string | undefined): string {
  // dbt colors its failure header, so on the wire it's actually
  // "\x1b[31mFailure in model ...\x1b[0m" -- strip ANSI codes first, both
  // so the `^failure in` anchor can match it and so the displayed message
  // doesn't carry raw escape bytes.
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  const stdoutLines = stripAnsi(stdout || '').split('\n');
  let failureIdx = -1;
  stdoutLines.forEach((l, i) => {
    if (/^failure in (model|test)/i.test(l)) failureIdx = i;
  });

  if (failureIdx !== -1) {
    return stdoutLines.slice(failureIdx, failureIdx + 10).join('\n').trim();
  }

  const combined = stripAnsi([stdout, stderr].filter(Boolean).join('\n'));
  const lines = combined.split('\n');
  const dbtLines = lines.filter((l) =>
    /catalog error|compilation error|runtime error|ERROR creating|ERROR reverting/i.test(l)
  );
  const errorLines = (dbtLines.length > 0 ? dbtLines : lines.filter((l) => /error|failed/i.test(l))).slice(-6);
  return errorLines.length > 0
    ? errorLines.join('\n')
    : lines.slice(-6).join('\n') || 'unknown error';
}
