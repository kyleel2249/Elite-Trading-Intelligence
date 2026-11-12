"""Execution error taxonomy. The type decides whether an operation may be retried."""
from __future__ import annotations


class ExecutionError(Exception):
    """Base class."""


class ProviderError(ExecutionError):
    """Any failure talking to a broker/exchange."""


class TransientProviderError(ProviderError):
    """Network failure, timeout, 429 or 5xx. Safe to retry reads; writes need reconciliation first."""


class UnknownOutcomeError(TransientProviderError):
    """An order submission may or may not have reached the venue. Never blind-resend."""


class PermanentProviderError(ProviderError):
    """Authentication, permission or malformed-request failure. Retrying will not help."""


class OrderRejectedError(PermanentProviderError):
    """The venue explicitly rejected the order."""


class ProviderUnavailableError(ProviderError):
    """Adapter is not implemented, not configured, or its circuit breaker is open."""


class PermissionPolicyError(PermanentProviderError):
    """Credentials carry permissions ETI refuses to use (for example withdrawals)."""
