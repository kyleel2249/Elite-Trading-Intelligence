"""Guards against routers being mounted twice (duplicate routes / duplicate OpenAPI operation IDs)."""
import warnings

from app.main import app


def test_openapi_has_no_duplicate_operation_ids():
    app.openapi_schema = None
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        schema = app.openapi()
    dupes = [str(w.message) for w in caught if "Duplicate Operation ID" in str(w.message)]
    app.openapi_schema = None
    assert not dupes, "routers mounted more than once:\n" + "\n".join(dupes[:10])
    assert schema["paths"]


def test_chain_routes_are_still_served():
    paths = app.openapi()["paths"]
    assert any(p.startswith("/api/chain/") for p in paths), "chain wallet routes are not mounted"
