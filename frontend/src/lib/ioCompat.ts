import { DBT_UPSTREAM_REASON, isDbtBackedType } from './dbtUpstream';

/** The slice of a graph node's data the check reads (all from the component schema's `x-dagster-io`). */
export interface IoNodeData {
  label?: string;
  component_type?: string | null;
  io_input_type?: string | null;
  io_input_required?: boolean;
  io_output_type?: string | null;
}

// Outputs a DataFrame input can never read: control objects, sinks and integrations, not tabular data.
const NON_TABULAR_OUTPUTS = new Set([
  'materializeresult', 'sink', 'integration', 'runrequest', 'assetspec', 'assetobservation', 'resource',
]);

const norm = (t: string | null | undefined) => (t || '').trim().toLowerCase();

/**
 * Whether `source` may feed `target` by an edge. Returns null when fine, otherwise the reason it isn't.
 *
 * - A DataFrame input is checked whether or not it is `required`: optional only means the component can also run from
 *   its own `source`; if you DO wire an upstream, that upstream has to produce a DataFrame.
 * - dbt assets declare "dataframe" but only write a warehouse table, so they never satisfy it.
 * - Unknown types stay permissive unless the input is required.
 */
export function ioIncompatibility(source: IoNodeData, target: IoNodeData): string | null {
  const need = norm(target.io_input_type);
  const have = norm(source.io_output_type);
  if (!need || need === 'any' || need === 'none') return null;

  if (!have) {
    return target.io_input_required
      ? `"${source.label ?? 'This asset'}" doesn't produce output, but "${target.label ?? 'the target'}" requires ${target.io_input_type} input.`
      : null;
  }
  if (have === 'any') return null;

  if (need === 'dataframe' && isDbtBackedType(source.component_type)) return DBT_UPSTREAM_REASON;

  // A required input keeps the original strict rule: the types must match.
  if (target.io_input_required && have !== need && !(need === 'dataframe' && have === 'dataframe')) {
    return `Type mismatch: "${source.label ?? 'the source'}" produces ${source.io_output_type}, but "${target.label ?? 'the target'}" requires ${target.io_input_type}.`;
  }
  // An optional DataFrame input still rejects what is clearly not tabular data.
  if (need === 'dataframe' && NON_TABULAR_OUTPUTS.has(have)) {
    return `"${source.label ?? 'The source'}" produces ${source.io_output_type}, but "${target.label ?? 'the target'}" needs a DataFrame.`;
  }
  return null;
}
