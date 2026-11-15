"""Default chart of accounts. Codes are stable identifiers used by the event templates."""
from __future__ import annotations

from app.accounting.domain import Account

# Well-known accounts referenced by events.py
CASH_BANK = "1010"
CASH_EXCHANGE = "1020"
AR = "1100"
CRYPTO_WALLET = "1210"
PREPAID = "1400"
SUSPENSE = "1990"
AP = "2000"
ACCRUED = "2100"
CAPITAL = "3000"
RETAINED = "3100"
DRAWS = "3200"
SERVICE_REVENUE = "4000"
TRADING_GAINS = "4100"
FUNDING_INCOME = "4110"
OTHER_INCOME = "4900"
TRADING_LOSSES = "5100"
EXCHANGE_FEES = "5200"
NETWORK_FEES = "5210"
INFRA = "5300"
MARKETING = "5400"
PAYROLL = "5500"
PROFESSIONAL = "5600"
OTHER_EXPENSE = "5900"

DEPARTMENTS = ("Trading", "Engineering", "Operations", "Marketing", "Administration", "Treasury")

DEFAULT_ACCOUNTS = [
    Account("1000", "Assets", "asset", postable=False, group="Assets"),
    Account("1010", "Operating Bank Account", "asset", "1000", cash=True, group="Cash"),
    Account("1020", "Exchange Cash (trading)", "asset", "1000", cash=True, group="Cash"),
    Account("1100", "Accounts Receivable", "asset", "1000", group="Receivables"),
    Account("1210", "Treasury Wallet (crypto)", "asset", "1000", cashflow="investing", group="Digital assets"),
    Account("1300", "Open Trading Positions (at cost)", "asset", "1000", cashflow="investing", group="Trading"),
    Account("1400", "Prepaid Expenses", "asset", "1000", group="Prepaid"),
    Account("1990", "Suspense / Unclassified Receipts and Payments", "asset", "1000", group="Suspense"),
    Account("2000", "Accounts Payable", "liability", group="Payables"),
    Account("2100", "Accrued Expenses", "liability", group="Accruals"),
    Account("2200", "Taxes Payable", "liability", group="Taxes"),
    Account("3000", "Owner's Capital", "equity", cashflow="financing", group="Equity"),
    Account("3100", "Retained Earnings", "equity", cashflow="financing", group="Equity"),
    Account("3200", "Owner's Distributions", "equity", cashflow="financing", group="Equity"),
    Account("4000", "Service Revenue", "revenue", group="Operating revenue"),
    Account("4100", "Realized Trading Gains", "revenue", group="Trading"),
    Account("4110", "Funding and Interest Income", "revenue", group="Trading"),
    Account("4900", "Other Income", "revenue", group="Other income"),
    Account("5100", "Realized Trading Losses", "expense", group="Trading"),
    Account("5200", "Exchange and Broker Fees", "expense", group="Trading"),
    Account("5210", "Network (Gas) Fees", "expense", group="Trading"),
    Account("5300", "Software and Infrastructure", "expense", group="Operating expenses"),
    Account("5400", "Marketing", "expense", group="Operating expenses"),
    Account("5500", "Payroll and Contractors", "expense", group="Operating expenses"),
    Account("5600", "Professional Fees", "expense", group="Operating expenses"),
    Account("5900", "Other Expenses", "expense", group="Operating expenses"),
]
