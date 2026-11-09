# Global Alpha Intelligence: file map (repository root)

NEW
  app/alpha/: __init__, features, scoring, token_safety, db_models, providers, discovery, strategy_library, strategy_lab,
              predictions (adapter to app/prediction_ledger), investor_intel, whales, coverage, fusion, execution, sec_sync,
              research_job, context, omnisignal_bridge, fundamentals, macro
  app/api/alpha.py
  app/integrations/edgar/filings.py, app/integrations/explorer/{__init__,client}.py
  app/knowledge/research_alpha.py
  app/templates/alpha.html
  alembic/versions/0006_global_alpha.py
  docs/GLOBAL_ALPHA_PYTHON.md, docs/GLOBAL_ALPHA_IMPLEMENTATION_REPORT.md   (docs/GLOBAL_ALPHA.md is main's Worker doc and is untouched)
  tests/alpha_helpers.py, tests/test_alpha_{core,strategy_lab,ledger_investors,pipeline,api,omnisignal,fundamentals_macro}.py

MODIFIED (additive)
  .env.example README.md alembic/env.py app/config.py app/database.py app/main.py app/knowledge/registry.py
  app/integrations/edgar/client.py app/templates/index.html app/templates/alerts.html
