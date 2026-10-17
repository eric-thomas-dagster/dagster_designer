"""A tiny catalog for the UI smoke test: a 3-step chain in one group, one loose asset in another, one check."""
import dagster as dg


@dg.asset(group_name="orders")
def raw_orders() -> int:
    return 1


@dg.asset(group_name="orders", deps=[raw_orders])
def clean_orders() -> int:
    return 2


@dg.asset(group_name="orders", deps=[clean_orders])
def order_totals() -> int:
    return 3


@dg.asset(group_name="misc")
def lonely_asset() -> int:
    return 4


@dg.asset_check(asset=clean_orders)
def clean_orders_not_empty() -> dg.AssetCheckResult:
    return dg.AssetCheckResult(passed=True)


@dg.definitions
def defs():
    return dg.Definitions(assets=[raw_orders, clean_orders, order_totals, lonely_asset], asset_checks=[clean_orders_not_empty])
