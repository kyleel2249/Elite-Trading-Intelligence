"""Department budgets enforced against the double-entry ledger (the ledger is the single source of spend)."""
from __future__ import annotations

from typing import Optional

from app.accounting.domain import ValidationError, check_department
from app.accounting.ledger import Ledger


class BudgetExceeded(Exception):
    pass


class DepartmentBudgets:
    def __init__(self, ledger: Ledger):
        self.ledger = ledger
        self._budgets: dict[tuple, int] = {}

    def set_budget(self, department: str, period: str, amount_units: int) -> None:
        if not check_department(department):
            raise ValidationError("department required")
        if len(period) != 7 or period[4] != "-":
            raise ValidationError("period must be YYYY-MM")
        if not isinstance(amount_units, int) or isinstance(amount_units, bool) or amount_units < 0:
            raise ValidationError("budget must be a non-negative integer in ledger units")
        self._budgets[(department, period)] = amount_units

    def budget(self, department: str, period: str) -> Optional[int]:
        return self._budgets.get((department, period))

    def spent(self, department: str, period: str) -> int:
        """Net expense (debits - credits on expense accounts) tagged to the department in the period."""
        accts = self.ledger.accounts()
        total = 0
        for e in self.ledger.store.entries(f"{period}-01", f"{period}-31"):
            for ln in e.lines:
                if ln.department == department and accts[ln.account].type == "expense":
                    total += ln.debit - ln.credit
        return total

    def remaining(self, department: str, period: str) -> int:
        b = self.budget(department, period)
        if b is None:
            raise BudgetExceeded(f"no budget set for {department} in {period}")
        return b - self.spent(department, period)

    def check(self, department: str, period: str, amount_units: int) -> None:
        """Raise BudgetExceeded unless `amount_units` more spend fits. Departments without a budget cannot spend."""
        if amount_units <= 0:
            raise ValidationError("amount must be positive")
        left = self.remaining(department, period)
        if amount_units > left:
            raise BudgetExceeded(f"{department} {period}: requested {amount_units} exceeds remaining {left}")
