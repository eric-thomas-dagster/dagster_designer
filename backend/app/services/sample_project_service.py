"""A ready-made project for first-time users: a small pipeline that runs offline with nothing installed or configured.

It is plain Dagster code (assets, an asset check, a schedule) so it shows what the graph, the asset pages, materializing and checks
look like straight away -- and everything in it is safe to edit or delete.
"""

from __future__ import annotations

from pathlib import Path

SAMPLE_NAME = "Coffee Shop Sample"
SAMPLE_DESCRIPTION = "A tiny sample pipeline. Everything in it runs offline: open an asset and press Materialize."

SAMPLE_ASSETS_PY = '''"""Sample pipeline: a coffee shop's orders, cleaned up and summarised. Edit anything, or delete this folder."""

import random

import dagster as dg

PRODUCTS = {"espresso": 3.0, "latte": 4.5, "cappuccino": 4.25, "cold brew": 5.0, "croissant": 3.5}


@dg.asset(group_name="coffee_shop", kinds={"python"}, description="Orders as they arrive from the till (some rows are messy on purpose).")
def raw_orders() -> dg.Output[list[dict]]:
    rng = random.Random(42)
    rows = []
    for i in range(1, 201):
        product = rng.choice(list(PRODUCTS))
        rows.append({
            "order_id": i,
            "product": product.upper() if i % 7 == 0 else product,  # inconsistent casing
            "quantity": rng.randint(1, 4),
            "unit_price": None if i % 29 == 0 else PRODUCTS[product],  # a few missing prices
        })
    return dg.Output(rows, metadata={"rows": len(rows)})


@dg.asset(group_name="coffee_shop", kinds={"python"}, description="Orders with consistent product names and missing prices filled in.")
def cleaned_orders(raw_orders: list[dict]) -> dg.Output[list[dict]]:
    cleaned = []
    for row in raw_orders:
        product = row["product"].lower()
        cleaned.append({**row, "product": product, "unit_price": row["unit_price"] if row["unit_price"] is not None else PRODUCTS[product]})
    return dg.Output(cleaned, metadata={"rows": len(cleaned), "fixed_prices": sum(r["unit_price"] is None for r in raw_orders)})


@dg.asset(group_name="coffee_shop", kinds={"python"}, description="Revenue and units sold for each product.")
def revenue_by_product(cleaned_orders: list[dict]) -> dg.Output[dict]:
    totals: dict = {}
    for row in cleaned_orders:
        entry = totals.setdefault(row["product"], {"units": 0, "revenue": 0.0})
        entry["units"] += row["quantity"]
        entry["revenue"] = round(entry["revenue"] + row["quantity"] * row["unit_price"], 2)
    best = max(totals, key=lambda p: totals[p]["revenue"])
    return dg.Output(totals, metadata={"best_seller": best, "total_revenue": round(sum(v["revenue"] for v in totals.values()), 2)})


@dg.asset_check(asset=cleaned_orders, description="Every order has a product, a quantity and a price.")
def orders_are_complete(cleaned_orders: list[dict]) -> dg.AssetCheckResult:
    bad = [r["order_id"] for r in cleaned_orders if not r["product"] or r["quantity"] < 1 or r["unit_price"] is None]
    return dg.AssetCheckResult(passed=not bad, metadata={"bad_rows": len(bad)})


daily_refresh = dg.ScheduleDefinition(
    name="daily_refresh",
    cron_schedule="0 7 * * *",
    target=dg.AssetSelection.groups("coffee_shop"),
    default_status=dg.DefaultScheduleStatus.STOPPED,
)
'''


def add_sample_files(defs_dir: Path) -> Path:
    """Writes the sample pipeline under ``<defs_dir>/coffee_shop`` and returns that folder."""
    target = defs_dir / "coffee_shop"
    target.mkdir(parents=True, exist_ok=True)
    (target / "__init__.py").write_text("")
    (target / "assets.py").write_text(SAMPLE_ASSETS_PY)
    return target


def unique_name(existing: list[str], base: str = SAMPLE_NAME) -> str:
    """The sample's name, numbered when the person already has one (so creating it twice never collides)."""
    taken = {n.strip().lower() for n in existing}
    if base.lower() not in taken:
        return base
    n = 2
    while f"{base} {n}".lower() in taken:
        n += 1
    return f"{base} {n}"
