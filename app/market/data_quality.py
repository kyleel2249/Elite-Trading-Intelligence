"""Basic data quality checks."""
from datetime import datetime, timezone
from typing import Optional

from app.integrations.base import NormalizedQuote


def assess_quote(quote: NormalizedQuote, max_age_seconds: int = 300) -> NormalizedQuote:
    now = datetime.now(timezone.utc)
    age = (now - quote.ts_utc).total_seconds() if quote.ts_utc else None
    status = quote.data_status
    if quote.price is None or quote.price <= 0:
        status = "invalid"
    elif age is not None:
        if age > max_age_seconds * 3:
            status = "stale"
        elif age > max_age_seconds:
            status = "delayed"
        else:
            status = "fresh"
    quote.data_status = status
    return quote
