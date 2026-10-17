import { describe, expect, it } from 'vitest';
import { conciseValidationReason } from './validationReason';

const PYDANTIC = `dagster.components.core.component_tree.ComponentTreeException: Error while loading component customers_with_domain[0]:
pydantic_core._pydantic_core.ValidationError: 1 validation error for DataframeExtractFieldComponent
\`attributes.source at /p/defs/customers_with_domain/defs.yaml:8\`
  Input should be a valid dictionary [type=dict_type, input_value='@(.+)$', input_type=str]
    For further information visit https://errors.pydantic.dev/2.14/v/dict_type`;

describe('conciseValidationReason', () => {
  it('names the component, the field and what was wrong', () => {
    expect(conciseValidationReason(PYDANTIC)).toBe("customers_with_domain: attributes.source -- Input should be a valid dictionary (got '@(.+)$')");
  });
  it('reads a missing component class from a dagster symbol error', () => {
    const t = "Loading location p failed:\n\ndagster_shared.error.DagsterUnresolvableSymbolError: Module `dagster_community_components` has no attribute `DataframeTransformerComponent`.\n\nStack Trace:";
    expect(conciseValidationReason(t)).toBe('Module `dagster_community_components` has no attribute `DataframeTransformerComponent`.');
  });
  it('falls back to a recognisable dagster error line', () => {
    expect(conciseValidationReason("Error while loading component x[0]:\nComponent type 'a.B' not found.")).toContain("x: Component type 'a.B' not found");
  });
  it('is null when there is nothing to say', () => {
    expect(conciseValidationReason('')).toBeNull();
    expect(conciseValidationReason('all fine')).toBeNull();
  });
});
