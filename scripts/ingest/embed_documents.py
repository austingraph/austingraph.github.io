"""Embed parcel_documents that lack an embedding, using OpenAI
text-embedding-3-small (1536-dim, matching the parcel_embeddings schema).

Selects documents with no row in parcel_embeddings, batches them through the
embeddings API, and inserts the vectors. Idempotent and resumable: only
un-embedded documents are processed, so partial runs simply continue next time.

Requires OPENAI_API_KEY in the environment. If it's absent, the script exits 0
(skips) so the rest of the pipeline still succeeds.
"""

import os
import json
import time
import urllib.request

from common import db, configured

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
MODEL = "text-embedding-3-small"
BATCH = 100


def embed_batch(texts):
    payload = json.dumps({"model": MODEL, "input": texts}).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=payload,
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode())
            return [item["embedding"] for item in sorted(data["data"], key=lambda d: d["index"])]
        except Exception as exc:  # noqa: BLE001
            wait = 2 ** attempt
            print(f"  embed failed ({exc}); retry in {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError("embedding API failed after retries")


def main():
    if not configured():
        return
    if not OPENAI_API_KEY:
        print("OPENAI_API_KEY not set; skipping embeddings step.", flush=True)
        return

    conn = db()
    total = 0
    while True:
        with conn.cursor() as cur:
            cur.execute(
                """
                select d.id, d.parcel_id, d.body
                from parcel_documents d
                left join parcel_embeddings e on e.document_id = d.id
                where e.id is null and d.body is not null and length(d.body) > 0
                limit %s
                """,
                (BATCH,),
            )
            rows = cur.fetchall()
        if not rows:
            break

        vectors = embed_batch([r[2] for r in rows])
        with conn.cursor() as cur:
            for (doc_id, parcel_id, _body), vec in zip(rows, vectors):
                cur.execute(
                    """
                    insert into parcel_embeddings (document_id, parcel_id, embedding)
                    values (%s, %s, %s)
                    """,
                    (doc_id, parcel_id, "[" + ",".join(map(str, vec)) + "]"),
                )
        conn.commit()
        total += len(rows)
        print(f"  embedded {total} documents", flush=True)

    print(f"embeddings done: {total} new vectors", flush=True)
    conn.close()


if __name__ == "__main__":
    main()
