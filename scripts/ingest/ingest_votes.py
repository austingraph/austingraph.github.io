"""Ingest Austin City Council voting records (Socrata 3c89-i35a).

Votes are linked to zoning cases — not directly to parcels. For each vote item
we extract a case number from item_description (regex C\\d{2}[A-Z]?-\\d{4}-\\d{4}).
If a matching 'case' node exists (created by ingest_zoning_cases), we upsert a
'vote' node and a 'has_vote' edge case→vote. Items with no case number, or whose
case isn't in the graph, are skipped (counted as unmatched) rather than guessed.

Run AFTER ingest_zoning_cases so the case nodes exist.
"""

import re

from common import db, configured, socrata_page, set_cursor, upsert_node, upsert_edge

DATASET = "3c89-i35a"
SOURCE = "votes"
PAGE = 1000
CASE_RE = re.compile(r"C\d{2}[A-Z]?-\d{4}-\d{4}")


def find_case_node(conn, case_number):
    with conn.cursor() as cur:
        cur.execute(
            "select id from kg_nodes where node_type = 'case' and external_id = %s",
            (case_number,),
        )
        row = cur.fetchone()
    return row[0] if row else None


def main():
    if not configured():
        return
    conn = db()
    # Always full-scan: a vote skipped earlier (case not yet ingested) becomes
    # linkable once its case exists, so we re-evaluate every item each run.
    offset = 0
    matched = unmatched = 0
    print("votes: full scan from offset 0", flush=True)

    while True:
        rows = socrata_page(DATASET, offset, PAGE)
        if not rows:
            break
        for row in rows:
            desc = row.get("item_description") or ""
            m = CASE_RE.search(desc)
            if not m:
                unmatched += 1
                continue
            case_number = m.group(0)
            case_node = find_case_node(conn, case_number)
            if not case_node:
                unmatched += 1
                continue

            vote_id = row.get("vote_id") or f"{row.get('item_id')}-{row.get('voter_name')}"
            metadata = {
                "voter_name": row.get("voter_name"),
                "vote_cast": row.get("vote_cast"),
                "action": row.get("action") or row.get("vote_result"),
                "meeting_date": row.get("meeting_date") or row.get("date"),
                "case_number": case_number,
            }
            vote_node = upsert_node(conn, "vote", vote_id, None,
                                    row.get("voter_name") or vote_id, metadata)
            upsert_edge(conn, case_node, vote_node, "has_vote")
            matched += 1

        conn.commit()
        offset += len(rows)
        set_cursor(conn, SOURCE, offset, {"matched": matched, "unmatched": unmatched})
        print(f"  offset {offset}: matched={matched} unmatched={unmatched}", flush=True)
        if len(rows) < PAGE:
            break

    print(f"votes done: matched={matched} unmatched={unmatched}", flush=True)
    conn.close()


if __name__ == "__main__":
    main()
