"""Ingest Austin zoning cases (Socrata edir-dcnf) into the knowledge graph.

For each case with coordinates: locate the containing parcel, upsert a 'case'
node + 'has_case' edge from the parcel node, and store a parcel_documents row
(source='zoning_case') for later embedding. Cases without coordinates or whose
point falls outside every parcel are counted as unlinked and skipped.

Idempotent: re-running upserts the same nodes/edges/documents.
"""

from common import (
    db, configured, socrata_page, get_cursor, set_cursor,
    link_point_to_parcel, upsert_parcel_node, upsert_node, upsert_edge, upsert_document,
)

DATASET = "edir-dcnf"
SOURCE = "zoning_cases"
PAGE = 1000


def build_body(row):
    parts = [
        row.get("case_number"),
        row.get("case_name"),
        f"Existing zoning: {row.get('existing_zoning')}" if row.get("existing_zoning") else None,
        f"Proposed zoning: {row.get('proposed_zoning')}" if row.get("proposed_zoning") else None,
        f"Status: {row.get('case_status')}" if row.get("case_status") else None,
        f"District: {row.get('council_district')}" if row.get("council_district") else None,
        row.get("site_address"),
    ]
    return " | ".join(p for p in parts if p)


def main():
    if not configured():
        return
    conn = db()
    offset = get_cursor(conn, SOURCE)
    linked = unlinked = 0
    print(f"zoning_cases: resuming at offset {offset}", flush=True)

    while True:
        rows = socrata_page(DATASET, offset, PAGE)
        if not rows:
            break
        for row in rows:
            case_number = row.get("case_number")
            if not case_number:
                continue
            lon = row.get("longitude")
            lat = row.get("latitude")
            parcel_id = link_point_to_parcel(conn, lon, lat)
            if not parcel_id:
                unlinked += 1
                continue

            metadata = {
                "status": row.get("case_status"),
                "zoning": (f"{row.get('existing_zoning', '')} → {row.get('proposed_zoning', '')}".strip(" →")) or None,
                "district": row.get("council_district"),
                "approval_date": row.get("approval_date") or row.get("date_filed"),
                "site_address": row.get("site_address"),
            }
            parcel_node = upsert_parcel_node(conn, parcel_id)
            case_node = upsert_node(conn, "case", case_number, parcel_id,
                                    row.get("case_name") or case_number, metadata)
            upsert_edge(conn, parcel_node, case_node, "has_case")
            upsert_document(conn, parcel_id, "zoning_case", case_number,
                            build_body(row), {"case_number": case_number})
            linked += 1

        conn.commit()
        offset += len(rows)
        set_cursor(conn, SOURCE, offset, {"linked": linked, "unlinked": unlinked})
        print(f"  offset {offset}: linked={linked} unlinked={unlinked}", flush=True)
        if len(rows) < PAGE:
            break

    print(f"zoning_cases done: linked={linked} unlinked={unlinked}", flush=True)
    conn.close()


if __name__ == "__main__":
    main()
