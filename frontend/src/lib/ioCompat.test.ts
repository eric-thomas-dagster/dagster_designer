import { describe, expect, it } from 'vitest';
import { ioIncompatibility } from './ioCompat';

const dbt = { label: 'seeds/raw_customers', component_type: 'p.components.enriched_dbt_project.EnrichedDbtProjectComponent', io_output_type: 'dataframe' };
const frame = { label: 'clean', component_type: 'dagster_community_components.AutoFieldComponent', io_output_type: 'dataframe' };
const optionalFrameIn = { label: 'auto_field', io_input_type: 'dataframe', io_input_required: false };
const requiredFrameIn = { label: 'sink', io_input_type: 'dataframe', io_input_required: true };

describe('ioIncompatibility', () => {
  it('blocks a dbt asset feeding a DataFrame input even when the input is optional', () => {
    expect(ioIncompatibility(dbt, optionalFrameIn)).toMatch(/dbt/);
    expect(ioIncompatibility(dbt, requiredFrameIn)).toMatch(/dbt/);
  });
  it('allows DataFrame to DataFrame, case-insensitively', () => {
    expect(ioIncompatibility(frame, optionalFrameIn)).toBeNull();
    expect(ioIncompatibility({ ...frame, io_output_type: 'DataFrame' }, requiredFrameIn)).toBeNull();
  });
  it('rejects non-tabular outputs into a DataFrame input, optional or not', () => {
    expect(ioIncompatibility({ label: 'sync', io_output_type: 'MaterializeResult' }, optionalFrameIn)).toMatch(/DataFrame/);
    expect(ioIncompatibility({ label: 'x', io_output_type: 'sink' }, requiredFrameIn)).not.toBeNull();
  });
  it('stays permissive when the source type is unknown and the input is optional, strict when required', () => {
    expect(ioIncompatibility({ label: 'x' }, optionalFrameIn)).toBeNull();
    expect(ioIncompatibility({ label: 'x' }, requiredFrameIn)).toMatch(/doesn't produce output/);
  });
  it('ignores targets with no declared input, "any" or "none"', () => {
    expect(ioIncompatibility(dbt, { label: 't' })).toBeNull();
    expect(ioIncompatibility(dbt, { label: 't', io_input_type: 'any' })).toBeNull();
    expect(ioIncompatibility(dbt, { label: 't', io_input_type: 'none' })).toBeNull();
  });
  it('keeps the strict rule for other required types', () => {
    expect(ioIncompatibility({ label: 'a', io_output_type: 'text' }, { label: 'b', io_input_type: 'dict', io_input_required: true })).toMatch(/mismatch/);
    expect(ioIncompatibility({ label: 'a', io_output_type: 'text' }, { label: 'b', io_input_type: 'dict', io_input_required: false })).toBeNull();
  });
});
