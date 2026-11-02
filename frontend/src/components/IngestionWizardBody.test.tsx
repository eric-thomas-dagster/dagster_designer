// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { IngestionWizardBody } from './IngestionWizardBody';

afterEach(cleanup);

const properties: Record<string, any> = {
  asset_name: { type: 'string', label: 'Asset Name', default: 'shopify_data' },
  shop_url: { type: 'string', label: 'Shop Url' },
  private_app_password: { type: 'string', label: 'Private App Password' },
  resources: { type: 'array', label: 'Resources', description: 'Shopify resources to extract (customers, orders, products)' },
  destination: { type: 'string', label: 'Destination' },
  destination_credentials_url: { type: 'string', label: 'Credentials' },
  owners: { type: 'array', label: 'Owners' },
  freshness_cron: { type: 'string', label: 'Freshness cron' },
};
const required = ['asset_name', 'shop_url'];

function Harness(p: { onFinish?: () => void; onAdvanced?: () => void; initial?: Record<string, any> }) {
  const [data, setData] = useState<Record<string, any>>(p.initial ?? {});
  return (
    <IngestionWizardBody
      componentType="ds.components.shopify_ingestion.component.ShopifyIngestionComponent"
      displayName="Shopify"
      properties={properties}
      required={required}
      formData={data}
      onFieldChange={(f, v) => setData((d) => ({ ...d, [f]: v }))}
      renderEntry={(name) => (
        <label>
          {name}
          <input
            aria-label={name}
            value={typeof data[name] === 'string' ? data[name] : ''}
            onChange={(e) => setData((d) => ({ ...d, [name]: e.target.value }))}
          />
        </label>
      )}
      onFinish={p.onFinish ?? (() => {})}
      onAdvanced={p.onAdvanced ?? (() => {})}
      onCancel={() => {}}
      isDraft={false}
    />
  );
}

describe('IngestionWizardBody', () => {
  it('starts on Connect with only connection fields and blocks Next until required fields are filled', () => {
    render(<Harness />);
    expect(screen.getByRole('heading', { name: 'Connect to Shopify' })).toBeTruthy();
    expect(screen.getByLabelText('shop_url')).toBeTruthy();
    expect(screen.getByLabelText('private_app_password')).toBeTruthy();
    expect(screen.queryByLabelText('resources')).toBeNull();
    expect(screen.queryByLabelText('owners')).toBeNull();

    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Required')).toBeTruthy(); // shop_url missing; asset_name has a default
    expect(screen.getByRole('heading', { name: 'Connect to Shopify' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('shop_url'), { target: { value: 'my.myshopify.com' } });
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByRole('heading', { name: 'What to load' })).toBeTruthy();
  });

  it('offers the options named in a field description as toggle chips', () => {
    render(<Harness initial={{ shop_url: 'x' }} />);
    fireEvent.click(screen.getByText('Next'));
    const orders = screen.getByRole('button', { name: 'orders' });
    fireEvent.click(orders);
    fireEvent.click(screen.getByRole('button', { name: 'customers' }));
    expect(screen.getByRole('button', { name: 'orders' }).className).toContain('bg-blue-50');
    fireEvent.click(screen.getByRole('button', { name: 'orders' }));
    expect(screen.getByRole('button', { name: 'orders' }).className).not.toContain('bg-blue-50');
  });

  it('fills a secret with an env-var reference on request', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText(/Read it from an environment variable/));
    expect((screen.getByLabelText('private_app_password') as HTMLInputElement).value).toBe('${SHOPIFY_PRIVATE_APP_PASSWORD}');
  });

  it('walks to Review, summarises without echoing secrets, tucks optional settings away, and finishes', () => {
    const onFinish = vi.fn();
    render(<Harness onFinish={onFinish} initial={{ shop_url: 'my.myshopify.com', private_app_password: 'hunter2hunter2' }} />);
    fireEvent.click(screen.getByText('Next')); // load
    fireEvent.click(screen.getByText('Next')); // destination
    expect(screen.getByRole('heading', { name: 'Where it goes' })).toBeTruthy();
    fireEvent.click(screen.getByText('Next')); // review
    expect(screen.getByText('my.myshopify.com')).toBeTruthy();
    expect(screen.queryByText('hunter2hunter2')).toBeNull();
    expect(screen.getByText('Optional settings')).toBeTruthy();
    fireEvent.click(screen.getByText('Add data source'));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('shows an env-var reference as typed', () => {
    render(<Harness initial={{ shop_url: 'a', private_app_password: '${SHOPIFY_PRIVATE_APP_PASSWORD}' }} />);
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('${SHOPIFY_PRIVATE_APP_PASSWORD}')).toBeTruthy();
  });

  it('lets the user bail out to the advanced form', () => {
    const onAdvanced = vi.fn();
    render(<Harness onAdvanced={onAdvanced} />);
    fireEvent.click(screen.getByText('Switch to the advanced form'));
    expect(onAdvanced).toHaveBeenCalled();
  });
});
