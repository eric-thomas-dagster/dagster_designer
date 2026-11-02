// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { DltRestWizardBody } from './DltRestWizardBody';

afterEach(cleanup);

const properties: Record<string, any> = {
  asset_name: { type: 'string', label: 'Asset Name' },
  client: { type: 'object', label: 'Client' },
  resources: { type: 'array', label: 'Resources' },
  destination: { type: 'string', label: 'Destination' },
  dataset_name: { type: 'string', label: 'Dataset Name' },
  destination_credentials_url: { type: 'string', label: 'Credentials' },
  group_name: { type: 'string', label: 'Group' },
};

let latest: Record<string, any> = {};
function Harness({ initial = {}, onFinish = () => {} }: { initial?: Record<string, any>; onFinish?: () => void }) {
  const [data, setData] = useState<Record<string, any>>(initial);
  latest = data;
  return (
    <DltRestWizardBody
      componentType="dagster_community_components.DltRestApiSourceComponent"
      displayName="REST API"
      properties={properties}
      required={['asset_name', 'client', 'resources']}
      formData={data}
      onFieldChange={(f, v) => setData((d) => ({ ...d, [f]: v }))}
      renderEntry={(name) => (
        <label>
          {name}
          <input aria-label={name} value={typeof data[name] === 'string' ? data[name] : ''} onChange={(e) => setData((d) => ({ ...d, [name]: e.target.value }))} />
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

describe('DltRestWizardBody', () => {
  it('builds client and resources from the forms and finishes', () => {
    const onFinish = vi.fn();
    render(<Harness onFinish={onFinish} />);
    type('asset_name', 'acme_api');
    type('Base URL', 'https://api.acme.com/v1');
    type('Authentication', 'bearer');
    type('Token variable', 'ACME_TOKEN');
    type('Pagination', 'cursor');
    type('Cursor parameter', 'cursor');
    type('Cursor path', 'next_cursor');
    expect(latest.client).toEqual({
      base_url: 'https://api.acme.com/v1',
      auth: { type: 'bearer', token: '{{ env.ACME_TOKEN }}' },
      paginator: { type: 'cursor', cursor_param: 'cursor', cursor_path: 'next_cursor' },
    });
    next();

    expect(screen.getByRole('heading', { name: 'Endpoints' })).toBeTruthy();
    type('Table name 1', 'customers');
    type('Path 1', 'customers');
    type('Data selector 1', 'results');
    type('Query parameters 1', 'limit=100');
    fireEvent.click(screen.getByText('Add another endpoint'));
    type('Table name 2', 'orders');
    type('Path 2', 'orders');
    type('Write mode 2', 'merge');
    type('Primary key 2', 'id');
    expect(latest.resources).toEqual([
      { name: 'customers', endpoint: { path: 'customers', data_selector: 'results', params: { limit: 100 } } },
      { name: 'orders', endpoint: { path: 'orders' }, primary_key: 'id', write_disposition: 'merge' },
    ]);
    next();

    expect(screen.getByRole('heading', { name: 'Where it goes' })).toBeTruthy();
    next();
    expect(screen.getByRole('heading', { name: 'Review' })).toBeTruthy();
    expect(screen.getByText('https://api.acme.com/v1')).toBeTruthy();
    expect(screen.getByText(/Bearer token \(\{\{ env\.ACME_TOKEN \}\}\)/)).toBeTruthy();
    expect(screen.getAllByText('customers').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Add data source'));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('refuses a pasted secret in place of a variable name, and a bad base URL', () => {
    render(<Harness />);
    type('asset_name', 'a');
    type('Base URL', 'api.acme.com');
    next();
    expect(screen.getByRole('heading', { name: 'API' })).toBeTruthy();
    expect(screen.getByText(/must start with http/)).toBeTruthy();
    type('Base URL', 'https://api.acme.com');
    type('Authentication', 'bearer');
    type('Token variable', 'sk_live_abc 123');
    next();
    expect(screen.getByText(/NAME of the environment variable/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'API' })).toBeTruthy();
    type('Token variable', 'ACME_TOKEN');
    next();
    expect(screen.getByRole('heading', { name: 'Endpoints' })).toBeTruthy();
  });

  it('needs at least a named endpoint with a path before moving on', () => {
    render(<Harness initial={{ asset_name: 'a' }} />);
    type('Base URL', 'https://x.io');
    next();
    next();
    expect(screen.getByRole('heading', { name: 'Endpoints' })).toBeTruthy();
    expect(screen.getByText(/enter the path/)).toBeTruthy();
    type('Table name 1', 'rows');
    type('Path 1', 'rows');
    next();
    expect(screen.getByRole('heading', { name: 'Where it goes' })).toBeTruthy();
  });

  it('starts from an existing client/resources (the type example) and keeps them', () => {
    render(<Harness initial={{
      asset_name: 'my_vendor_ingestion',
      client: { base_url: 'https://mysite.chargify.com', auth: { type: 'http_basic', username: 'u', password: '{{ env.MY_VENDOR_API_KEY }}' } },
      resources: [{ name: 'customers', endpoint: { path: 'customers.json', data_selector: '$' } }],
    }} />);
    expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe('https://mysite.chargify.com');
    expect((screen.getByLabelText('Authentication') as HTMLSelectElement).value).toBe('http_basic');
    expect((screen.getByLabelText('Password variable') as HTMLInputElement).value).toBe('MY_VENDOR_API_KEY');
    expect(latest.resources).toEqual([{ name: 'customers', endpoint: { path: 'customers.json', data_selector: '$' } }]);
  });
});
