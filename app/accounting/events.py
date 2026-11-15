"""Journal templates: every financial event maps to a balanced EntrySpec. Amounts are integer units."""
from __future__ import annotations

from typing import Optional

from app.accounting import coa
from app.accounting.domain import EntrySpec, Line, ValidationError


def capital_contribution(date: str, units: int, ref: str, currency: str = "USD", cash: str = coa.CASH_BANK,
                         by: str = "system") -> EntrySpec:
    return EntrySpec(date, "capital", ref, [Line(cash, units, 0, currency, external_ref=ref),
                                            Line(coa.CAPITAL, 0, units, currency)], "Capital contribution", posted_by=by)


def owner_distribution(date: str, units: int, ref: str, currency: str = "USD", cash: str = coa.CASH_BANK,
                       by: str = "system") -> EntrySpec:
    return EntrySpec(date, "distribution", ref, [Line(coa.DRAWS, units, 0, currency),
                                                 Line(cash, 0, units, currency, external_ref=ref)],
                     "Owner distribution", posted_by=by)


def expense_paid(date: str, expense_account: str, units: int, department: str, vendor: str, ref: str,
                 currency: str = "USD", cash: str = coa.CASH_BANK, memo: str = "", by: str = "system") -> EntrySpec:
    """Expense paid immediately in cash (use a bill when it is payable later)."""
    return EntrySpec(date, "expense", ref, [Line(expense_account, units, 0, currency, department, counterparty=vendor, memo=memo),
                                            Line(cash, 0, units, currency, counterparty=vendor, external_ref=ref)],
                     memo or f"Expense paid to {vendor}", posted_by=by)


def internal_transfer(date: str, from_account: str, to_account: str, units: int, ref: str, currency: str = "USD",
             by: str = "system") -> EntrySpec:
    return EntrySpec(date, "transfer", ref, [Line(to_account, units, 0, currency, external_ref=ref),
                                             Line(from_account, 0, units, currency)], "Internal transfer", posted_by=by)


def trade_closed(trade_id: str, date: str, symbol: str, strategy: Optional[str], environment: str, gross_pnl_units: int,
                 fees_units: int = 0, currency: str = "USD", cash: str = coa.CASH_EXCHANGE, by: str = "system") -> Optional[EntrySpec]:
    """Realized P&L and fees of a closed trade. Returns None when there is nothing to book (zero P&L and fees)."""
    if fees_units < 0:
        raise ValidationError("fees must be >= 0")
    kw = dict(currency=currency, symbol=symbol, strategy=strategy)
    lines = []
    if gross_pnl_units > 0:
        lines += [Line(cash, gross_pnl_units, 0, **kw), Line(coa.TRADING_GAINS, 0, gross_pnl_units, department="Trading", **kw)]
    elif gross_pnl_units < 0:
        lines += [Line(coa.TRADING_LOSSES, -gross_pnl_units, 0, department="Trading", **kw), Line(cash, 0, -gross_pnl_units, **kw)]
    if fees_units:
        lines += [Line(coa.EXCHANGE_FEES, fees_units, 0, department="Trading", **kw), Line(cash, 0, fees_units, **kw)]
    if not lines:
        return None
    return EntrySpec(date, "trade", trade_id, lines, f"Closed trade {symbol}", environment,
                     meta={"gross_pnl_units": gross_pnl_units, "fees_units": fees_units}, posted_by=by)


def funding(ref: str, date: str, symbol: str, environment: str, units: int, currency: str = "USD",
            cash: str = coa.CASH_EXCHANGE, by: str = "system") -> EntrySpec:
    """Funding / interest: positive = received, negative = paid."""
    kw = dict(currency=currency, symbol=symbol)
    if units >= 0:
        lines = [Line(cash, units, 0, **kw), Line(coa.FUNDING_INCOME, 0, units, department="Trading", **kw)]
    else:
        lines = [Line(coa.EXCHANGE_FEES, -units, 0, department="Trading", **kw), Line(cash, 0, -units, **kw)]
    return EntrySpec(date, "funding", ref, lines, "Funding / interest", environment, posted_by=by)


def chain_tx(source: str, ext_id: str, date: str, wallet_account: str, currency: str, amount: int, fee: int = 0,
             fee_currency: Optional[str] = None, counterparty: Optional[str] = None, by: str = "system") -> EntrySpec:
    """Books an on-chain transfer that is missing from the ledger. The other side goes to SUSPENSE: ETI never guesses
    whether an inflow was revenue, capital or a transfer. Classify it afterwards with a reclassification entry."""
    if amount == 0 and fee == 0:
        raise ValidationError("nothing to book")
    lines = []
    if amount > 0:
        lines += [Line(wallet_account, amount, 0, currency, counterparty=counterparty, external_ref=ext_id),
                  Line(coa.SUSPENSE, 0, amount, currency, counterparty=counterparty, memo="unclassified receipt")]
    elif amount < 0:
        lines += [Line(coa.SUSPENSE, -amount, 0, currency, counterparty=counterparty, memo="unclassified payment"),
                  Line(wallet_account, 0, -amount, currency, counterparty=counterparty, external_ref=ext_id)]
    if fee:
        fc = fee_currency or currency
        lines += [Line(coa.NETWORK_FEES, fee, 0, fc, "Treasury", counterparty=counterparty, memo="network fee"),
                  Line(wallet_account, 0, fee, fc, "Treasury", external_ref=ext_id)]
    return EntrySpec(date, "chain_tx", f"{source}:{ext_id}", lines, f"On-chain transaction {ext_id[:18]}",
                     "internal", meta={"source": source, "ext_id": ext_id}, posted_by=by)
