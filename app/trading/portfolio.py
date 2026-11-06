"""Paper portfolio: positions, fills, journal with filters."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models import OrderRecord, Position, JournalEntry


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
    ) -> OrderRecord:
        row = (
            self.db.query(OrderRecord)
            .filter(OrderRecord.client_order_id == client_order_id)
            .one_or_none()
        )
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
            row.updated_at = datetime.utcnow()

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

        if status in ("submitted", "filled") and fill_price is not None and risk_approved:
            self._apply_fill(
                provider=provider,
                environment=environment,
                symbol=symbol,
                side=side,
                qty=qty,
                price=fill_price,
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
            pos.updated_at = datetime.utcnow()
            return

        if qty < pos.qty:
            if pos.side == "long":
                pnl = (price - pos.avg_entry) * qty
            else:
                pnl = (pos.avg_entry - price) * qty
            pos.qty -= qty
            pos.realized_pnl += pnl
            pos.mark_price = price
            pos.updated_at = datetime.utcnow()
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
            pos.updated_at = datetime.utcnow()
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
            pos.updated_at = datetime.utcnow()
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
                p.updated_at = datetime.utcnow()
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
