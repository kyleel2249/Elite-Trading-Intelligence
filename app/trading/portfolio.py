"""Paper portfolio: positions, fills, journal with filters."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional
import json
import math

from sqlalchemy.orm import Session

from app.models import OrderRecord, Position, JournalEntry


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class PortfolioService:
    """Claire Bennett standards: every event reconstructable."""

    def __init__(self, db: Session):
        self.db = db

    def record_order_event(
        self,
        *,
        client_order_id: str,
        provider: str,
        environment: str,
        symbol: str,
        side: str,
        qty: float,
        status: str,
        fill_price: Optional[float] = None,
        risk_approved: bool = False,
        risk_notes: str = "",
        council_action: Optional[str] = None,
        thesis: Optional[str] = None,
        provider_order_id: Optional[str] = None,
        filled_qty: Optional[float] = None,
    ) -> OrderRecord:
        row = (
            self.db.query(OrderRecord)
            .filter(OrderRecord.client_order_id == client_order_id)
            .with_for_update()
            .populate_existing()
            .one_or_none()
        )
        # Cumulative execution state lives in the existing notes column, avoiding
        # an implicit schema migration. Legacy filled rows are already accounted.
        previous_qty = previous_cost = 0.0
        metadata = {}
        if row is not None:
            if (row.provider, row.environment, row.symbol, row.side, row.qty) != (
                    provider, environment, symbol.upper(), side.lower(), qty):
                raise ValueError("Client order ID belongs to a different order")
            try:
                metadata = json.loads(row.notes or "{}")
                if not isinstance(metadata, dict):
                    metadata = {"legacy_notes": row.notes}
            except (ValueError, TypeError):
                metadata = {"legacy_notes": row.notes}
            state = metadata.get("execution_accounting")
            if state:
                previous_qty, previous_cost = float(state["qty"]), float(state["cost"])
            elif row.status == "filled":
                previous_qty = row.qty
                previous_cost = row.qty * (row.fill_price or 0)
        cumulative = filled_qty if filled_qty is not None else (qty if status == "filled" else previous_qty)
        if not math.isfinite(cumulative) or cumulative < 0 or cumulative > qty:
            raise ValueError("Invalid cumulative execution quantity")
        if cumulative < previous_qty:
            raise ValueError("Execution quantity cannot regress")
        delta = cumulative - previous_qty
        cost = previous_cost
        delta_price = None
        if cumulative > previous_qty:
            if fill_price is None or not math.isfinite(fill_price) or fill_price <= 0:
                raise ValueError("Execution requires a finite positive price")
            cost = cumulative * fill_price
            delta_price = (cost - previous_cost) / delta
            if not math.isfinite(delta_price) or delta_price <= 0:
                raise ValueError("Invalid execution cost delta")
        if status == "filled" and not math.isclose(cumulative, qty, rel_tol=1e-10, abs_tol=1e-12):
            raise ValueError("Filled status requires the entire order quantity")
        if row is not None and row.status in {"filled", "canceled", "rejected", "expired"}:
            if status not in {"filled", "canceled", "rejected", "expired"}:
                status = row.status
        metadata["execution_accounting"] = {"qty": cumulative, "cost": cost}
        encoded = json.dumps(metadata, sort_keys=True)
        if row is not None:
            # Compare-and-swap protects same-order replays on SQLite as well as
            # databases supporting SELECT FOR UPDATE. Caller must retry conflicts.
            changed = self.db.query(OrderRecord).filter(
                OrderRecord.id == row.id, OrderRecord.notes == row.notes
            ).update({OrderRecord.notes: encoded}, synchronize_session=False)
            if changed != 1:
                self.db.rollback()
                raise ValueError("Concurrent execution update; retry reconciliation")
        if row is None:
            row = OrderRecord(
                client_order_id=client_order_id,
                provider=provider,
                environment=environment,
                symbol=symbol.upper(),
                side=side.lower(),
                order_type="market",
                qty=qty,
                status=status,
                fill_price=fill_price,
                risk_approved=risk_approved,
                risk_notes=risk_notes,
                provider_order_id=provider_order_id,
            )
            self.db.add(row)
        else:
            row.status = status
            row.fill_price = fill_price if fill_price is not None else row.fill_price
            row.risk_approved = risk_approved
            row.risk_notes = risk_notes or row.risk_notes
            row.provider_order_id = provider_order_id or row.provider_order_id
            row.updated_at = _utcnow()

        row.notes = encoded
        self._journal(
            client_order_id=client_order_id,
            provider=provider,
            environment=environment,
            symbol=symbol,
            side=side,
            qty=qty,
            price=fill_price,
            event=status,
            thesis=thesis,
            council_action=council_action,
            risk_officer="Helena Frost",
        )

        if delta > 0 and risk_approved:
            self._apply_fill(
                provider=provider,
                environment=environment,
                symbol=symbol,
                side=side,
                qty=delta,
                price=delta_price,
            )

        self.db.commit()
        self.db.refresh(row)
        return row

    def _apply_fill(
        self,
        *,
        provider: str,
        environment: str,
        symbol: str,
        side: str,
        qty: float,
        price: float,
    ) -> None:
        symbol = symbol.upper()
        side = side.lower()
        pos = (
            self.db.query(Position)
            .filter(
                Position.provider == provider,
                Position.environment == environment,
                Position.symbol == symbol,
                Position.status == "open",
            )
            .one_or_none()
        )

        if pos is None:
            pos_side = "long" if side == "buy" else "short"
            pos = Position(
                provider=provider,
                environment=environment,
                symbol=symbol,
                side=pos_side,
                qty=qty,
                avg_entry=price,
                mark_price=price,
                status="open",
            )
            self.db.add(pos)
            return

        if (pos.side == "long" and side == "buy") or (pos.side == "short" and side == "sell"):
            new_qty = pos.qty + qty
            pos.avg_entry = ((pos.avg_entry * pos.qty) + (price * qty)) / new_qty if new_qty else price
            pos.qty = new_qty
            pos.mark_price = price
            pos.unrealized_pnl = ((price - pos.avg_entry) if pos.side == "long" else (pos.avg_entry - price)) * pos.qty
            pos.updated_at = _utcnow()
            return

        if qty < pos.qty:
            if pos.side == "long":
                pnl = (price - pos.avg_entry) * qty
            else:
                pnl = (pos.avg_entry - price) * qty
            pos.qty -= qty
            pos.realized_pnl += pnl
            pos.mark_price = price
            pos.unrealized_pnl = ((price - pos.avg_entry) if pos.side == "long" else (pos.avg_entry - price)) * pos.qty
            pos.updated_at = _utcnow()
            self._journal(
                client_order_id=None,
                provider=provider,
                environment=environment,
                symbol=symbol,
                side=side,
                qty=qty,
                price=price,
                event="closed",
                pnl=pnl,
                thesis="Partial position reduce",
            )
        elif qty == pos.qty:
            if pos.side == "long":
                pnl = (price - pos.avg_entry) * qty
            else:
                pnl = (pos.avg_entry - price) * qty
            pos.qty = 0
            pos.realized_pnl += pnl
            pos.status = "closed"
            pos.mark_price = price
            pos.unrealized_pnl = ((price - pos.avg_entry) if pos.side == "long" else (pos.avg_entry - price)) * pos.qty
            pos.updated_at = _utcnow()
            self._journal(
                client_order_id=None,
                provider=provider,
                environment=environment,
                symbol=symbol,
                side=side,
                qty=qty,
                price=price,
                event="closed",
                pnl=pnl,
                thesis="Full position close",
            )
        else:
            close_qty = pos.qty
            if pos.side == "long":
                pnl = (price - pos.avg_entry) * close_qty
            else:
                pnl = (pos.avg_entry - price) * close_qty
            remainder = qty - close_qty
            pos.realized_pnl += pnl
            pos.side = "short" if pos.side == "long" else "long"
            pos.qty = remainder
            pos.avg_entry = price
            pos.mark_price = price
            pos.status = "open"
            pos.unrealized_pnl = ((price - pos.avg_entry) if pos.side == "long" else (pos.avg_entry - price)) * pos.qty
            pos.updated_at = _utcnow()
            self._journal(
                client_order_id=None,
                provider=provider,
                environment=environment,
                symbol=symbol,
                side=side,
                qty=close_qty,
                price=price,
                event="closed",
                pnl=pnl,
                thesis="Position flip — closed leg",
            )

    def mark_positions(self, marks: dict[tuple[str, str, str], float]) -> list[Position]:
        open_pos = self.db.query(Position).filter(Position.status == "open").all()
        for p in open_pos:
            key = (p.provider, p.environment, p.symbol)
            if key in marks:
                px = marks[key]
                p.mark_price = px
                if p.side == "long":
                    p.unrealized_pnl = (px - p.avg_entry) * p.qty
                else:
                    p.unrealized_pnl = (p.avg_entry - px) * p.qty
                p.updated_at = _utcnow()
        self.db.commit()
        return open_pos

    def list_positions(self, environment: Optional[str] = None, status: str = "open") -> list[Position]:
        q = self.db.query(Position)
        if environment:
            q = q.filter(Position.environment == environment)
        if status:
            q = q.filter(Position.status == status)
        return q.order_by(Position.updated_at.desc()).all()

    def list_journal(
        self,
        limit: int = 50,
        *,
        symbol: Optional[str] = None,
        event: Optional[str] = None,
        environment: Optional[str] = None,
        provider: Optional[str] = None,
        side: Optional[str] = None,
    ) -> list[JournalEntry]:
        q = self.db.query(JournalEntry)
        if symbol:
            q = q.filter(JournalEntry.symbol == symbol.upper())
        if event:
            q = q.filter(JournalEntry.event == event)
        if environment:
            q = q.filter(JournalEntry.environment == environment)
        if provider:
            q = q.filter(JournalEntry.provider == provider)
        if side:
            q = q.filter(JournalEntry.side == side.lower())
        return q.order_by(JournalEntry.created_at.desc()).limit(min(limit, 500)).all()

    def portfolio_summary(self, environment: str = "paper") -> dict[str, Any]:
        positions = self.list_positions(environment=environment, status="open")
        realized = sum(
            p.realized_pnl
            for p in self.db.query(Position).filter(Position.environment == environment).all()
        )
        unrealized = sum(p.unrealized_pnl for p in positions)
        return {
            "environment": environment,
            "open_positions": len(positions),
            "realized_pnl": realized,
            "unrealized_pnl": unrealized,
            "net_pnl": realized + unrealized,
            "positions": [
                {
                    "symbol": p.symbol,
                    "side": p.side,
                    "qty": p.qty,
                    "avg_entry": p.avg_entry,
                    "mark_price": p.mark_price,
                    "unrealized_pnl": p.unrealized_pnl,
                    "realized_pnl": p.realized_pnl,
                }
                for p in positions
            ],
            "auditor": "Claire Bennett",
            "risk_officer": "Helena Frost",
        }

    def _journal(self, **kwargs: Any) -> None:
        entry = JournalEntry(
            client_order_id=kwargs.get("client_order_id"),
            provider=kwargs.get("provider", ""),
            environment=kwargs.get("environment", "paper"),
            symbol=(kwargs.get("symbol") or "").upper(),
            side=(kwargs.get("side") or "").lower(),
            qty=float(kwargs.get("qty") or 0),
            price=kwargs.get("price"),
            event=kwargs.get("event", "note"),
            pnl=kwargs.get("pnl"),
            thesis=kwargs.get("thesis"),
            council_action=kwargs.get("council_action"),
            risk_officer=kwargs.get("risk_officer", "Helena Frost"),
            payload=kwargs.get("payload"),
        )
        self.db.add(entry)
