"""ETI external intelligence providers (calendar, token unlocks, whale data).

Every provider sits behind the same ``ProviderClient`` (retries with jittered backoff, circuit breaker,
TTL cache, health tracking, secret redaction) and is registered under a *capability*, so a second provider
can be added for the same capability without touching callers.
"""
