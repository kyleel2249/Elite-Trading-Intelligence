# PostgreSQL mode

ETI uses SQLAlchemy and works with SQLite (default) or PostgreSQL without code changes.

## Connection string

```bash
# .env
DATABASE_URL=postgresql+psycopg2://USER:PASSWORD@HOST:5432/DBNAME
```

Install the driver:

```bash
pip install psycopg2-binary
```

Or add to your environment requirements.

## Docker Compose (optional Postgres sidecar)

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: eti
      POSTGRES_PASSWORD: eti
      POSTGRES_DB: eti
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  eti:
    build: .
    ports:
      - "8000:8000"
    environment:
      DATABASE_URL: postgresql+psycopg2://eti:eti@db:5432/eti
    depends_on:
      - db

volumes:
  pgdata:
```

## Schema

On startup `init_db()` runs `Base.metadata.create_all`. For production migrations, introduce Alembic when schema churn stabilizes.

## Notes

- Do not use SQLite file paths for multi-worker production.
- Keep secrets in environment / secret manager.
- UTC timestamps remain canonical in application logic.
