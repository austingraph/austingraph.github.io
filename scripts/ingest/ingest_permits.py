"""Ingest Austin issued construction permits (Socrata 3syk-w9eu).

Same shape as zoning cases: point-in-parcel link, 'permit' node + 'has_permit'
edge, and a parcel_documents row (source='permit'). This dataset is large, so a
per-run page budget (MAX_PAGES) bounds nightly runtime; the cursor resumes where
the previous run stopped and wraps back to 0 once the dataset is exhausted.
"""

from common import (
    db, configured, socrata_page, get_cursor, set_cursor,
    link_point_to_parcel, upsert_parcel_node, upsert_node, upsert_edge, upsert_document,
)

DATASET = "3syk-w9eu"
SOURCE = "permits"
PAGE = 1000
MAX_PAGES = 20  # ~20k rows per nightly run (bounded so votes + embeddings also run)


def field(row, *names):
    for n in names:
        if row.get(n):
            return row.get(n)
    return None


def build_body(row, permit_number):
    parts = [
        permit_number,
        field(row, "permit_type_desc", "permit_class", "permit_type"),
        field(row, "description"),
        field(row, "original_address1", "project_name"),
        f"Status: {field(row, 'status_current', 'permit_status')}" if field(row, "status_current", "permit_status") else None,
    ]
    return " | ".join(p for p in parts if p)


def main():
    if not configured():
        return
    conn = db()
    start = get_cursor(conn, SOURCE)
    offset = start
    linked = unlinked = pages = 0
    print(f"permits: resuming at offset {offset}", flush=True)

    while pages < MAX_PAGES:
        rows = socrata_page(DATASET, offset, PAGE)
        if not rows:
            offset = 0  # wrap to start on next run
            break
        for row in rows:
            permit_number = field(row, "permit_number", "permitnum", "permit_num")
            if not permit_number:
                continue
            lon = field(row, "longitude", "longitude_coordinate")
            lat = field(row, "latitude", "latitude_coordinate")
            parcel_id = link_point_to_parcel(conn, lon, lat)
            if not parcel_id:
                unlinked += 1
                continue

            metadata = {
                "type": field(row, "permit_type_desc", "permit_class", "permit_type"),
                "status": field(row, "status_current", "permit_status"),
                "issue_date": field(row, "issued_date", "issue_date", "applieddate"),
            }
            parcel_node = upsert_parcel_node(conn, parcel_id)
            permit_node = upsert_node(conn, "permit", permit_number, parcel_id,
                                      metadata["type"] or permit_number, metadata)
            upsert_edge(conn, parcel_node, permit_node, "has_permit")
            upsert_document(conn, parcel_id, "permit", permit_number,
                            build_body(row, permit_number), {"permit_number": permit_number})
            linked += 1

        conn.commit()
        offset += len(rows)
        pages += 1
        set_cursor(conn, SOURCE, offset, {"linked": linked, "unlinked": unlinked})
        print(f"  offset {offset}: linked={linked} unlinked={unlinked}", flush=True)
        if len(rows) < PAGE:
            offset = 0  # wrap to start on next run
            break

    set_cursor(conn, SOURCE, offset, {"linked": linked, "unlinked": unlinked})
    print(f"permits done: linked={linked} unlinked={unlinked} next_offset={offset}", flush=True)
    conn.close()


if __name__ == "__main__":
    main()
