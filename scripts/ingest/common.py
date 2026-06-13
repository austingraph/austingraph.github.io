"""Shared helpers for the civic-data ingestion scripts.

Reads DATABASE_URL (Supabase session-pooler connection string, service role)
from the environment. Each ingest script is idempotent and cursor-driven via
the kg_ingest_state table created in scripts/kg_schema.sql.
"""

import os
import sys
import time
import json
import urllib.request
import urllib.parse

import psycopg

DATABASE_URL = os.environ.get("DATABASE_URL")
SOCRATA_DOMAIN = "data.austintexas.gov"


def db():
    """Open a psycopg connection. Fails loudly if DATABASE_URL is missing."""
    if not DATABASE_URL:
        sys.exit("DATABASE_URL is not set. Add it as a GitHub Actions secret.")
    return psycopg.connect(DATABASE_URL, autocommit=False)


def configured():
    """True if DATABASE_URL is present. When False, scripts skip as a clean
    no-op (exit 0) so a scheduled run before secrets are set does not fail."""
    if not DATABASE_URL:
        print("DATABASE_URL not set; skipping (no-op). Add the repo secret to "
              "enable ingestion.", flush=True)
        return False
    return True


def socrata_page(dataset_id, offset, limit, select=None, where=None, order="$offset"):
    """Fetch one page from a Socrata dataset as a list of dicts.

    Uses the SODA 2.1 JSON endpoint with $limit/$offset paging. A stable
    $order is required for correct paging; defaults to the row offset.
    """
    params = {"$limit": str(limit), "$offset": str(offset), "$order": order}
    if select:
        params["$select"] = select
    if where:
        params["$where"] = where
    url = f"https://{SOCRATA_DOMAIN}/resource/{dataset_id}.json?" + urllib.parse.urlencode(params)
    return _get_json(url)


def _get_json(url, retries=4):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "austingraph-ingest/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode())
        except Exception as exc:  # noqa: BLE001
            last = exc
            wait = 2 ** attempt
            print(f"  fetch failed ({exc}); retrying in {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"giving up on {url}: {last}")


def get_cursor(conn, source):
    """Return the stored $offset cursor (int) for a source, or 0."""
    with conn.cursor() as cur:
        cur.execute("select cursor_value from kg_ingest_state where source = %s", (source,))
        row = cur.fetchone()
    if row and row[0] is not None:
        try:
            return int(row[0])
        except ValueError:
            return 0
    return 0


def set_cursor(conn, source, cursor_value, result):
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into kg_ingest_state (source, cursor_value, last_run, last_result)
            values (%s, %s, now(), %s)
            on conflict (source) do update
              set cursor_value = excluded.cursor_value,
                  last_run     = excluded.last_run,
                  last_result  = excluded.last_result
            """,
            (source, str(cursor_value), json.dumps(result)),
        )
    conn.commit()


def link_point_to_parcel(conn, lon, lat):
    """Return the parcel_id containing (lon, lat), or None."""
    if lon is None or lat is None:
        return None
    with conn.cursor() as cur:
        cur.execute("select public.link_point_to_parcel(%s, %s)", (float(lon), float(lat)))
        row = cur.fetchone()
    return row[0] if row else None


def upsert_parcel_node(conn, parcel_id):
    """Ensure a 'parcel' node exists for parcel_id; return its uuid."""
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into kg_nodes (node_type, external_id, parcel_id, label)
            values ('parcel', %s, %s, %s)
            on conflict (node_type, external_id) where external_id is not null
              do update set parcel_id = excluded.parcel_id
            returning id
            """,
            (parcel_id, parcel_id, parcel_id),
        )
        return cur.fetchone()[0]


def upsert_node(conn, node_type, external_id, parcel_id, label, metadata):
    """Upsert a typed node keyed on (node_type, external_id); return its uuid."""
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into kg_nodes (node_type, external_id, parcel_id, label, metadata)
            values (%s, %s, %s, %s, %s)
            on conflict (node_type, external_id) where external_id is not null
              do update set parcel_id = excluded.parcel_id,
                            label     = excluded.label,
                            metadata  = excluded.metadata
            returning id
            """,
            (node_type, external_id, parcel_id, label, json.dumps(metadata)),
        )
        return cur.fetchone()[0]


def upsert_edge(conn, from_node, to_node, edge_type, metadata=None):
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into kg_edges (from_node, to_node, edge_type, metadata)
            values (%s, %s, %s, %s)
            on conflict (from_node, to_node, edge_type) do nothing
            """,
            (from_node, to_node, edge_type, json.dumps(metadata or {})),
        )


def upsert_document(conn, parcel_id, source, source_id, body, metadata=None):
    """Insert a parcel_documents row for later embedding; de-duped on source/source_id."""
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into parcel_documents (parcel_id, source, source_id, body, metadata)
            values (%s, %s, %s, %s, %s)
            on conflict (source, source_id) where source_id is not null
              do update set parcel_id = excluded.parcel_id,
                            body      = excluded.body,
                            metadata  = excluded.metadata
            """,
            (parcel_id, source, source_id, body, json.dumps(metadata or {})),
        )
