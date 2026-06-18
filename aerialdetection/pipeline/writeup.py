"""Stage 5 — Claude reasoning + writeup.

The semantic half of the system. Claude reads the parcel chip plus the
*already-computed* measurements and permit context, and returns a schema-valid
finding whose narrative cites the measured numbers — and never invents one.

This is the one stage with a concrete reference implementation, because the
Claude call shape is the part most worth pinning down early:

  - Structured outputs (`output_config.format`) → schema-valid finding, no
    prose-parsing, no prefill.
  - Prompt caching → the system prompt + zoning rulebook + schema are a large,
    stable prefix shared by every parcel; cache it once per batch.
  - The "cite, never invent" system prompt → what makes the output defensible.
  - Adaptive thinking + effort → tuned per tier (see ../ARCHITECTURE.md).

For a county-wide run, submit these as a single Message Batch (50% cost,
non-latency-sensitive) rather than one synchronous call per parcel.

Model IDs are current as of writing; re-check with the `claude-api` skill:
  bulk = claude-sonnet-4-6, final high-severity = claude-opus-4-8.
"""
from __future__ import annotations

import base64
import json

import anthropic

# Stable prefix — cache this. Any per-parcel data goes in the user turn only.
SYSTEM = """You are a land-use compliance analyst reviewing one Austin/Travis \
County parcel from an aerial image plus measurements computed by a geometry \
engine (PostGIS). Your job is to decide whether the parcel likely has a code or \
planning issue, how severe it is, and to write a short, defensible explanation.

Rules you must follow:
- Every numeric claim in your writeup MUST come from a value in `measurements`. \
If a number is not in `measurements`, do not state it — say it is unmeasured.
- The image is for semantic context only (what structures exist, whether they \
look consistent with the permit record). NEVER estimate a distance, area, or \
percentage from the image — those come only from `measurements`.
- Findings are advisory, not determinations. Stamp the imagery vintage and \
capture date. Account for the stated measurement tolerance before flagging a \
borderline setback.
- Calibrate `severity` to the magnitude of the exceedance and `confidence` to \
the measurement tolerance and permit certainty."""

# Schema the structured-output call is constrained to (mirrors results.sample.json).
FINDING_SCHEMA = {
    "type": "object",
    "properties": {
        "issue": {"type": "string"},
        "severity": {"type": "string", "enum": ["high", "medium", "low", "none"]},
        "confidence": {"type": "number"},
        "citations": {"type": "array", "items": {"type": "string"}},
        "writeup": {"type": "string"},
    },
    "required": ["issue", "severity", "confidence", "citations", "writeup"],
    "additionalProperties": False,
}


def build_request(chip_png: bytes, measurements: dict, permit_matches: list,
                  imagery_vintage: str, capture_date: str,
                  model: str = "claude-opus-4-8") -> dict:
    """Build the Messages API request body for one parcel.

    Reusable for both a synchronous `messages.create(**body)` call and as the
    `params` of a Message Batch request.
    """
    context = {
        "imagery_vintage": imagery_vintage,
        "capture_date": capture_date,
        "measurements": measurements,
        "permit_matches": permit_matches,
    }
    return {
        "model": model,
        "max_tokens": 1500,
        "thinking": {"type": "adaptive"},
        # Cache the rulebook/schema prefix; only the user turn varies per parcel.
        "system": [
            {"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}},
        ],
        "output_config": {
            "format": {"type": "json_schema", "schema": FINDING_SCHEMA},
            "effort": "high",
        },
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": base64.standard_b64encode(chip_png).decode(),
                        },
                    },
                    {
                        "type": "text",
                        "text": "Parcel context (numbers are ground truth — cite, "
                                "don't invent):\n" + json.dumps(context, indent=2),
                    },
                ],
            }
        ],
    }


def write_finding(chip_png: bytes, measurements: dict, permit_matches: list,
                  imagery_vintage: str, capture_date: str,
                  client: anthropic.Anthropic | None = None,
                  model: str = "claude-opus-4-8") -> dict:
    """Synchronous single-parcel finding. For bulk, batch build_request() bodies."""
    client = client or anthropic.Anthropic()
    body = build_request(chip_png, measurements, permit_matches,
                         imagery_vintage, capture_date, model)
    resp = client.messages.create(**body)

    if resp.stop_reason == "refusal":
        return {"issue": "review skipped (model declined)", "severity": "none",
                "confidence": 0.0, "citations": [], "writeup": ""}

    text = next(b.text for b in resp.content if b.type == "text")
    return json.loads(text)
