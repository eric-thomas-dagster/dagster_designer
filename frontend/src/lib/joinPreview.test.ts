import { describe, it, expect } from 'vitest';
import { computeJoinPreview } from './joinPreview';

const customers = [
  { customer_id: 1, name: 'Ada' },
  { customer_id: 2, name: 'Grace' },
  { customer_id: 3, name: 'Alan' },
];
const customerCols = ['customer_id', 'name'];

const orders = [
  { customer_id: 1, order_id: 100, name: 'first order' },
  { customer_id: 1, order_id: 101, name: 'second order' },
  { customer_id: 4, order_id: 102, name: 'orphan order' },
];
const orderCols = ['customer_id', 'order_id', 'name'];

describe('computeJoinPreview inner join', () => {
  it('produces one row per match and drops unmatched rows on both sides', () => {
    const result = computeJoinPreview({
      leftRows: customers, leftColumns: customerCols,
      rightRows: orders, rightColumns: orderCols,
      how: 'inner', on: ['customer_id'],
    });
    // customer 1 matches 2 orders -> 2 rows; customers 2/3 have no orders;
    // order for customer 4 has no customer -> all dropped.
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.customer_id === 1)).toBe(true);
  });

  it('suffixes the overlapping non-key "name" column from both sides', () => {
    const result = computeJoinPreview({
      leftRows: customers, leftColumns: customerCols,
      rightRows: orders, rightColumns: orderCols,
      how: 'inner', on: ['customer_id'],
    });
    expect(result.columns).toContain('name_x');
    expect(result.columns).toContain('name_y');
    expect(result.columns).not.toContain('name');
    expect(result.rows[0].name_x).toBe('Ada');
    expect(result.rows[0].name_y).toBe('first order');
  });

  it('keeps the join key column exactly once in the output', () => {
    const result = computeJoinPreview({
      leftRows: customers, leftColumns: customerCols,
      rightRows: orders, rightColumns: orderCols,
      how: 'inner', on: ['customer_id'],
    });
    expect(result.columns.filter((c) => c === 'customer_id')).toHaveLength(1);
  });

  it('classifies each output column by which side it came from', () => {
    const result = computeJoinPreview({
      leftRows: customers, leftColumns: customerCols,
      rightRows: orders, rightColumns: orderCols,
      how: 'inner', on: ['customer_id'],
    });
    expect(result.columnSource.customer_id).toBe('key');
    expect(result.columnSource.name_x).toBe('left');
    expect(result.columnSource.name_y).toBe('right');
    expect(result.columnSource.order_id).toBe('right');
  });

  it('lists exactly the columns renamed due to a real naming collision', () => {
    const result = computeJoinPreview({
      leftRows: customers, leftColumns: customerCols,
      rightRows: orders, rightColumns: orderCols,
      how: 'inner', on: ['customer_id'],
    });
    // "name" collided (both sides have it) -- customer_id didn't (it's the
    // join key, shown once) and order_id didn't (only on the right side).
    expect(result.conflictColumns.sort()).toEqual(['name_x', 'name_y']);
  });
});

describe('computeJoinPreview left join', () => {
  it('keeps every left row, filling unmatched right columns with null', () => {
    const result = computeJoinPreview({
      leftRows: customers, leftColumns: customerCols,
      rightRows: orders, rightColumns: orderCols,
      how: 'left', on: ['customer_id'],
    });
    // customer 1 -> 2 rows, customer 2 -> 1 unmatched row, customer 3 -> 1 unmatched row
    expect(result.rows).toHaveLength(4);
    const unmatched = result.rows.find((r) => r.customer_id === 2);
    expect(unmatched?.order_id).toBeNull();
  });
});

describe('computeJoinPreview right join', () => {
  it('keeps every right row, filling unmatched left columns with null', () => {
    const result = computeJoinPreview({
      leftRows: customers, leftColumns: customerCols,
      rightRows: orders, rightColumns: orderCols,
      how: 'right', on: ['customer_id'],
    });
    // orders for customer 1 (x2) + orphan order for customer 4 (unmatched) = 3 rows
    expect(result.rows).toHaveLength(3);
    const orphan = result.rows.find((r) => r.order_id === 102);
    expect(orphan?.name_x).toBeNull();
  });
});

describe('computeJoinPreview outer join', () => {
  it('includes unmatched rows from both sides plus matches, with no duplicates', () => {
    const result = computeJoinPreview({
      leftRows: customers, leftColumns: customerCols,
      rightRows: orders, rightColumns: orderCols,
      how: 'outer', on: ['customer_id'],
    });
    // 2 matched (customer 1) + 2 unmatched customers (2,3) + 1 unmatched order (4) = 5
    expect(result.rows).toHaveLength(5);
  });
});

describe('computeJoinPreview cross join', () => {
  it('produces the full cartesian product', () => {
    const result = computeJoinPreview({
      leftRows: customers, leftColumns: customerCols,
      rightRows: orders, rightColumns: orderCols,
      how: 'cross',
    });
    expect(result.rows).toHaveLength(customers.length * orders.length);
  });

  it('respects maxRows and reports truncation', () => {
    const result = computeJoinPreview({
      leftRows: customers, leftColumns: customerCols,
      rightRows: orders, rightColumns: orderCols,
      how: 'cross', maxRows: 3,
    });
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });
});

describe('computeJoinPreview with leftOn/rightOn (differently-named keys)', () => {
  it('joins on differently-named columns and keeps both key columns in the output', () => {
    const left = [{ id: 1, label: 'a' }, { id: 2, label: 'b' }];
    const right = [{ ref_id: 1, value: 'x' }];
    const result = computeJoinPreview({
      leftRows: left, leftColumns: ['id', 'label'],
      rightRows: right, rightColumns: ['ref_id', 'value'],
      how: 'inner', leftOn: ['id'], rightOn: ['ref_id'],
    });
    expect(result.rows).toHaveLength(1);
    expect(result.columns).toEqual(['id', 'label', 'ref_id', 'value']);
    expect(result.rows[0]).toEqual({ id: 1, label: 'a', ref_id: 1, value: 'x' });
  });

  it('classifies both differently-named key columns by their own side (neither is "key")', () => {
    const left = [{ id: 1, label: 'a' }];
    const right = [{ ref_id: 1, value: 'x' }];
    const result = computeJoinPreview({
      leftRows: left, leftColumns: ['id', 'label'],
      rightRows: right, rightColumns: ['ref_id', 'value'],
      how: 'inner', leftOn: ['id'], rightOn: ['ref_id'],
    });
    expect(result.columnSource.id).toBe('left');
    expect(result.columnSource.ref_id).toBe('right');
  });
});
