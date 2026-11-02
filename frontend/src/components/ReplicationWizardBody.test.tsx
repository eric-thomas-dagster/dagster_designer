// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ReplicationWizardBody } from './ReplicationWizardBody';

afterEach(cleanup);

const properties: Record<string, any> = {
  asset_name: { type: 'string', label: 'Asset Name' },
  source_type: { type: 'string', label: 'Source Type' },
  source_connection_env_var: { type: 'string', label: 'Source Connection Env Var' },
  target_type: { type: 'string', label: 'Target Type' },
  target_connection_env_var: { type: 'string', label: 'Target Connection Env Var' },
  source_table: { type: 'string', label: 'Source Table' },
  target_table: { type: 'string', label: 'Target Table' },
  mode: { type: 'string', label: 'Mode', default: 'full_refresh' },
  incremental_column: { type: 'string', label: 'Incremental Column' },
  primary_key: { type: 'array', label: 'Primary Key' },
  where_clause: { type: 'string', label: 'Where Clause' },
  owners: { type: 'array', label: 'Owners' },
};
const required = ['asset_name', 'source_type', 'source_connection_env_var', 'target_type', 'target_connection_env_var', 'source_table', 'target_table'];

function Harness({ onFinish = () => {} }: { onFinish?: () => void }) {
  const [data, setData] = useState<Record<string, any>>({});
  return (
    <ReplicationWizardBody
      componentType="dagster_community_components.DatabaseReplicationComponent"
      displayName="Database Replication"
      properties={properties}
      required={required}
      formData={data}
      onFieldChange={(f, v) => setData((d) => ({ ...d, [f]: v }))}
      renderEntry={(name) => (
        <label>
          {name}
          <input aria-label={name} value={Array.isArray(data[name]) ? data[name].join(',') : (data[name] ?? '')}
            onChange={(e) => setData((d) => ({ ...d, [name]: name === 'primary_key' ? e.target.value.split(',').filter(Boolean) : e.target.value }))} />
        </label>
      )}
      onFinish={onFinish}
      onAdvanced={() => {}}
      onCancel={() => {}}
      isDraft={false}
    />
  );
}
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const next = () => fireEvent.click(screen.getByText('Next'));

describe('ReplicationWizardBody', () => {
  it('walks Source -> Target -> Tables -> Review with autofill, then finishes', () => {
    const onFinish = vi.fn();
    render(<Harness onFinish={onFinish} />);
    expect(screen.getByRole('heading', { name: 'Source' })).toBeTruthy();
    type('source_type', 'postgres');
    expect((screen.getByLabelText('source_connection_env_var') as HTMLInputElement).value).toBe('POSTGRES_SOURCE_URL');
    expect(screen.getByText(/postgres:\/\/user:password@host:5432\/database/)).toBeTruthy();
    next();
    expect(screen.getByRole('heading', { name: 'Target' })).toBeTruthy();
    type('target_type', 'snowflake');
    expect((screen.getByLabelText('target_connection_env_var') as HTMLInputElement).value).toBe('SNOWFLAKE_TARGET_URL');
    next();
    expect(screen.getByRole('heading', { name: 'Tables & mode' })).toBeTruthy();
    type('source_table', 'public.orders');
    expect((screen.getByLabelText('target_table') as HTMLInputElement).value).toBe('orders');
    expect((screen.getByLabelText('asset_name') as HTMLInputElement).value).toBe('orders_replica');
    next();
    expect(screen.getByRole('heading', { name: 'Review' })).toBeTruthy();
    expect(screen.getByText('POSTGRES_SOURCE_URL')).toBeTruthy();
    expect(screen.getByText('Advanced load options')).toBeTruthy();
    fireEvent.click(screen.getByText('Add data source'));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('blocks an incremental load that has no watermark column or primary key', () => {
    render(<Harness />);
    type('source_type', 'postgres'); next();
    type('target_type', 'postgres'); next();
    type('source_table', 'orders');
    type('mode', 'incremental');
    next();
    expect(screen.getByRole('heading', { name: 'Tables & mode' })).toBeTruthy();
    expect(screen.getByText(/watermark column/)).toBeTruthy();
    type('incremental_column', 'updated_at');
    type('primary_key', 'id');
    next();
    expect(screen.getByRole('heading', { name: 'Review' })).toBeTruthy();
  });

  it('keeps a table name the user typed when the source table changes', () => {
    render(<Harness />);
    type('source_type', 'postgres'); next();
    type('target_type', 'postgres'); next();
    type('source_table', 'orders');
    type('target_table', 'dw.orders_v2');
    type('source_table', 'orders2');
    expect((screen.getByLabelText('target_table') as HTMLInputElement).value).toBe('dw.orders_v2');
  });
});
