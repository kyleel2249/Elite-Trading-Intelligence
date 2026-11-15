"""Reconciliation of external records (bank, exchange, blockchain) against the ledger."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from app.accounting import events
from app.accounting.domain import SCOPES, ValidationError, check_currency, parse_date
from app.accounting.ledger import Ledger
from app.accounting.money import fmt, to_units
from app.accounting.store import ExtTxn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ingest(ledger: Ledger, source: str, kind: str, rows: list[dict]) -> dict:
    """Store external transactions exactly as reported. (source, ext_id) is unique: re-importing is harmless."""
    if kind not in ("bank", "exchange", "chain"):
        raise ValidationError("kind must be bank, exchange or chain")
    accts = ledger.accounts()
    added = dup = 0
    for r in rows:
        acct = accts.get(str(r.get("account")))
        if acct is None or acct.type != "asset":
            raise ValidationError(f"unknown or non-asset ledger account {r.get('account')!r}")
        ext_id = str(r.get("ext_id") or r.get("tx_hash") or "").strip()
        if not ext_id:
            raise ValidationError("every external transaction needs an ext_id (bank reference / tx hash)")
        parse_date(r["date"])
        fee_cur = check_currency(r.get("fee_currency") or r["currency"])
        t = ExtTxn(source, ext_id, str(r["date"])[:10], acct.code, check_currency(r["currency"]), to_units(r["amount"]),
                   to_units(r.get("fee", 0)), kind, r.get("counterparty"), r.get("confirmations"),
                   {"fee_currency": fee_cur, **{k: v for k, v in r.items() if k in ("from", "to", "block", "memo", "chain")}},
                   _now())
        if t.fee < 0:
            raise ValidationError("fee must be >= 0")
        if ledger.store.add_ext_txn(t):
            added += 1
        else:
            dup += 1
    return {"added": added, "duplicates_ignored": dup}


def _internal_by_ref(ledger: Ledger, account: str, scope: str) -> dict[str, dict]:
    """ref(lowercase) -> {"net": {currency: units}, "entries": [entry_no]} (reversals net out automatically)."""
    envs = SCOPES[scope]
    out: dict[str, dict] = {}
    for e in ledger.store.entries():
        if e.environment not in envs:
            continue
        for l in e.lines:
            if l.account == account and l.external_ref:
                o = out.setdefault(l.external_ref.lower(), {"net": defaultdict(int), "entries": [], "dates": []})
                o["net"][l.currency] += l.debit - l.credit
                if e.entry_no not in o["entries"]:
                    o["entries"].append(e.entry_no)
                    o["dates"].append(e.date)
    return out


def reconcile_transactions(ledger: Ledger, source: str, account: str, date_from: str, date_to: str,
                           min_confirmations: int = 1, scope: str = "real", save: bool = True) -> dict:
    ext = [t for t in ledger.store.ext_txns(source, account) if date_from <= t.ts <= date_to]
    internal = _internal_by_ref(ledger, account, scope)
    seen = {t.ext_id.lower() for t in ledger.store.ext_txns(source, account)}
    matched, mismatched, missing_internal, pending = [], [], [], []
    for t in sorted(ext, key=lambda x: (x.ts, x.ext_id)):
        if t.kind == "chain" and (t.confirmations or 0) < min_confirmations:
            pending.append({"ext_id": t.ext_id, "date": t.ts, "confirmations": t.confirmations or 0})
            continue
        expected: dict[str, int] = defaultdict(int)
        expected[t.currency] += t.amount
        if t.fee:
            expected[t.meta.get("fee_currency", t.currency)] -= t.fee
        base = {"ext_id": t.ext_id, "date": t.ts, "currency": t.currency, "amount": fmt(t.amount), "fee": fmt(t.fee)}
        got = internal.get(t.ext_id.lower())
        if got is None:
            missing_internal.append(base)
            continue
        cur_set = set(expected) | set(got["net"])
        diff = {c: got["net"].get(c, 0) - expected.get(c, 0) for c in cur_set}
        diff = {c: v for c, v in diff.items() if v}
        if not diff:
            matched.append({**base, "entries": got["entries"]})
        else:
            hint = None
            for c, v in diff.items():
                exp = expected.get(c, 0)
                if exp and v % exp == 0 and v // exp >= 1:
                    hint = "internal amount is a multiple of the external amount: likely double-posted"
            mismatched.append({**base, "entries": got["entries"], "expected_net": {c: fmt(v) for c, v in expected.items()},
                               "internal_net": {c: fmt(v) for c, v in got["net"].items()},
                               "difference": {c: fmt(v) for c, v in diff.items()}, "hint": hint})
    missing_external = []
    for ref, o in internal.items():
        if ref not in seen and any(date_from <= d <= date_to for d in o["dates"]):
            missing_external.append({"external_ref": ref, "entries": o["entries"], "internal_net": {c: fmt(v) for c, v in o["net"].items() if v}})
    missing_external = [m for m in missing_external if m["internal_net"]]
    ok = not (mismatched or missing_internal or missing_external)
    res = {"kind": "transactions", "source": source, "account": account, "from": date_from, "to": date_to, "scope": scope,
           "status": "reconciled" if ok else "exceptions", "external_count": len(ext), "matched": matched,
           "amount_mismatch": mismatched, "missing_internal": missing_internal, "missing_external": missing_external,
           "pending_confirmation": pending,
           "counts": {"matched": len(matched), "amount_mismatch": len(mismatched), "missing_internal": len(missing_internal),
                      "missing_external": len(missing_external), "pending": len(pending)},
           "ran_at": _now()}
    if save:
        saved = ledger.store.save_run({k: res[k] for k in ("kind", "source", "account", "from", "to", "status", "counts", "ran_at")} | {"result": res})
        res["run_id"] = saved["id"]
    return res


def post_missing(ledger: Ledger, source: str, account: str, date_from: str, date_to: str, min_confirmations: int = 1,
                 by: str = "system") -> dict:
    """Books confirmed external transactions that are missing internally (to SUSPENSE). Explicit, idempotent."""
    rec = reconcile_transactions(ledger, source, account, date_from, date_to, min_confirmations, save=False)
    by_id = {t.ext_id: t for t in ledger.store.ext_txns(source, account)}
    posted, skipped = [], []
    for m in rec["missing_internal"]:
        t = by_id[m["ext_id"]]
        spec = events.chain_tx(source, t.ext_id, t.ts, account, t.currency, t.amount, t.fee, t.meta.get("fee_currency"),
                               t.counterparty, by)
        try:
            r = ledger.post(spec)
            posted.append({"ext_id": t.ext_id, "entry": r.entry.entry_no, "duplicate": r.duplicate})
        except Exception as exc:  # report per item; one failure must not hide the others
            skipped.append({"ext_id": t.ext_id, "error": str(exc)})
    return {"posted": posted, "skipped": skipped, "classification": "Booked to suspense (1990); reclassify with a journal entry."}


def reconcile_balance(ledger: Ledger, account: str, as_of: str, external_balance, currency: str, source: str,
                      note: str = "", scope: str = "real") -> dict:
    """Treasury reconciliation: external statement balance vs ledger balance on a date."""
    parse_date(as_of)
    a = ledger.accounts().get(account)
    if a is None or a.type != "asset":
        raise ValidationError("account must be an asset account")
    cur = check_currency(currency)
    ext = to_units(external_balance)
    envs = SCOPES[scope]
    gl = 0
    unref = 0
    for e in ledger.store.entries(None, as_of):
        if e.environment in envs:
            for l in e.lines:
                if l.account == account and l.currency == cur:
                    gl += l.debit - l.credit
                    if not l.external_ref:
                        unref += 1
    diff = gl - ext
    res = {"kind": "balance", "source": source, "account": account, "currency": cur, "as_of": as_of, "scope": scope,
           "external_balance": fmt(ext), "ledger_balance": fmt(gl), "difference": fmt(diff),
           "status": "reconciled" if diff == 0 else "unreconciled", "movements_without_external_reference": unref,
           "note": note, "ran_at": _now()}
    saved = ledger.store.save_run({"kind": "balance", "source": source, "account": account, "from": None, "to": as_of,
                                   "status": res["status"], "counts": {"difference_units": diff}, "ran_at": res["ran_at"], "result": res})
    res["run_id"] = saved["id"]
    return res
