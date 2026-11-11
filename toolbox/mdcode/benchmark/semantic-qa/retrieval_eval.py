"""Score a retriever against the benchmark's gold concept sets.

The task under test: a natural-language question arrives, Knowledge Catalog is
searched, and it must return the concepts needed to answer -- model, entity and
metric entries. This scores how well a retriever does that.

WHAT THE INDEX CONTAINS. It mirrors what `kcmd push` actually sends to KC, so a
number here means something about KC rather than about these YAML files:

  semantic-model   displayName, description, ai_context.instructions
  semantic-entity  name, description, instructions, and the schema aspect --
                   field names and field descriptions
  semantic-metric  name, description, instructions, owning entity

Two things are deliberately absent, both verified against the emitter:

  ai_context.synonyms  knowledge_catalog.py routes only `instructions` to the
                       guidelines aspect: "ai_context.synonyms/examples have no
                       home in this aspect". Synonyms reach the BigQuery graph
                       and not KC. Pass --with-synonyms to index them anyway;
                       the gap between the two runs is what fixing that would
                       be worth.
  relationships        they become schema-join entry LINKS, which carry
                       endpoints and join columns but no prose. Nothing to
                       index, and nothing to retrieve.

THE RETRIEVER is a plain BM25 baseline, here so the harness runs today and so
there is a floor to beat. It is NOT Knowledge Catalog search. Swap it by
writing a function with the same shape as `bm25_search` and passing
--retriever; the scoring below does not care where the ranking came from.

Run:  python3 -I benchmark/semantic-qa/retrieval_eval.py
      python3 -I benchmark/semantic-qa/retrieval_eval.py --with-synonyms
      python3 -I benchmark/semantic-qa/retrieval_eval.py --compare
"""

import argparse
from collections import Counter, defaultdict
import math
import os
import re
import sys

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(HERE, "models")
QUESTIONS_DIR = os.path.join(HERE, "questions")

CUTOFFS = (1, 3, 5, 10, 20)
GAIN = {"required": 3.0, "supporting": 1.0}


# --------------------------------------------------------------------------
# tokenization
# --------------------------------------------------------------------------


def tokenize(text):
  """Lowercase, split on non-alphanumerics, and also split snake_case parts.

  `net_revenue` yields net, revenue and net_revenue, so both a user phrase
  and an exact metric name can match.
  """
  out = []
  for raw in re.findall(r"[A-Za-z0-9_]+", (text or "").lower()):
    out.append(raw)
    if "_" in raw:
      out.extend(p for p in raw.split("_") if p)
  # Crude plural folding so "customers" matches "customer".
  return [t[:-1] if len(t) > 3 and t.endswith("s") else t for t in out]


# --------------------------------------------------------------------------
# build the index, entry by entry, the way kcmd publishes them
# --------------------------------------------------------------------------


def ai_text(obj, with_synonyms):
  ai = (obj or {}).get("ai_context") or {}
  parts = [ai.get("instructions") or ""]
  if with_synonyms:
    parts.extend(ai.get("synonyms") or [])
  return " ".join(p for p in parts if p)


def build_index(with_synonyms=False):
  """Returns {ref: text} over every entry a push would create."""
  docs = {}
  for fname in sorted(os.listdir(MODELS_DIR)):
    if not fname.endswith(".yaml"):
      continue
    stem = fname[: -len(".yaml")]
    doc = yaml.safe_load(open(os.path.join(MODELS_DIR, fname)))
    model = doc["semantic_model"][0]
    entities = model.get("entities") or model.get("datasets") or []

    docs[f"model:{stem}"] = " ".join([
        model.get("name", ""),
        model.get("description", "") or "",
        ai_text(model, with_synonyms),
    ])

    for ent in entities:
      # The schema aspect carries field names and their descriptions.
      fields = " ".join(
          f"{f.get('name','')} {f.get('label','') or ''} "
          f"{f.get('description','') or ''} {ai_text(f, with_synonyms)}"
          for f in ent.get("fields", [])
      )
      docs[f"{stem}.entity:{ent['name']}"] = " ".join([
          ent.get("name", ""),
          ent.get("description", "") or "",
          ai_text(ent, with_synonyms),
          fields,
      ])

    for met in model.get("metrics", []):
      docs[f"{stem}.metric:{met['name']}"] = " ".join([
          met.get("name", ""),
          met.get("description", "") or "",
          ai_text(met, with_synonyms),
      ])
  return docs


# --------------------------------------------------------------------------
# BM25 baseline
# --------------------------------------------------------------------------


class Bm25:

  def __init__(self, docs, k1=1.2, b=0.75):
    self.k1, self.b = k1, b
    self.refs = list(docs)
    self.tf = [Counter(tokenize(docs[r])) for r in self.refs]
    self.len = [sum(c.values()) for c in self.tf]
    self.avg = (sum(self.len) / len(self.len)) if self.len else 0.0
    df = Counter()
    for c in self.tf:
      df.update(c.keys())
    n = len(self.refs)
    self.idf = {
        t: math.log(1 + (n - d + 0.5) / (d + 0.5)) for t, d in df.items()
    }

  def search(self, query, limit=20):
    q = tokenize(query)
    scored = []
    for i, ref in enumerate(self.refs):
      tf, dl = self.tf[i], self.len[i]
      s = 0.0
      for t in q:
        f = tf.get(t)
        if not f:
          continue
        denom = f + self.k1 * (1 - self.b + self.b * dl / (self.avg or 1))
        s += self.idf.get(t, 0.0) * f * (self.k1 + 1) / denom
      if s > 0:
        scored.append((s, ref))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return scored[:limit]


# --------------------------------------------------------------------------
# gold
# --------------------------------------------------------------------------


def normalize(ref, ambient):
  """`metric:x` -> `model.metric:x`; `model:x` stays as is."""
  colon = ref.rindex(":")
  lhs, name = ref[:colon], ref[colon + 1 :]
  if lhs == "model":
    return f"model:{name}"
  if "." in lhs:
    return ref
  return f"{ambient}.{lhs}:{name}"


def load_questions():
  out = []
  for fname in sorted(os.listdir(QUESTIONS_DIR)):
    if not fname.endswith(".yaml"):
      continue
    doc = yaml.safe_load(open(os.path.join(QUESTIONS_DIR, fname)))
    ambient = doc.get("model")
    for q in doc.get("questions", []):
      exp = q.get("expect") or {}
      out.append({
          "id": f"{fname[:-5]}.{q['id']}",
          "kind": q.get("kind", "single-model"),
          "difficulty": q["difficulty"],
          "question": q["question"],
          "required": [normalize(r, ambient) for r in exp.get("required", [])],
          "supporting": [
              normalize(r, ambient) for r in exp.get("supporting", [])
          ],
          "forbidden": [
              normalize(r, ambient) for r in exp.get("forbidden", [])
          ],
      })
  return out


# --------------------------------------------------------------------------
# metrics
# --------------------------------------------------------------------------


def ndcg(ranked, gains, k=10):
  dcg = sum(
      gains.get(ref, 0.0) / math.log2(i + 2) for i, ref in enumerate(ranked[:k])
  )
  ideal = sorted(gains.values(), reverse=True)[:k]
  idcg = sum(g / math.log2(i + 2) for i, g in enumerate(ideal))
  return (dcg / idcg) if idcg else 0.0


def evaluate(index, questions, label):
  engine = Bm25(index)
  answerable = [q for q in questions if q["kind"] != "negative"]
  negatives = [q for q in questions if q["kind"] == "negative"]

  recall = {k: [] for k in CUTOFFS}
  full = {k: [] for k in CUTOFFS}  # every required entry present
  rr, nd = [], []
  by_difficulty = defaultdict(list)
  missed = Counter()

  for q in answerable:
    ranked = [
        ref for _, ref in engine.search(q["question"], limit=max(CUTOFFS))
    ]
    req = set(q["required"])
    gains = {r: GAIN["required"] for r in q["required"]}
    for r in q["supporting"]:
      gains.setdefault(r, GAIN["supporting"])

    for k in CUTOFFS:
      top = set(ranked[:k])
      recall[k].append(len(req & top) / len(req) if req else 0.0)
      full[k].append(1.0 if req <= top else 0.0)

    pos = next((i for i, r in enumerate(ranked) if r in req), None)
    rr.append(1.0 / (pos + 1) if pos is not None else 0.0)
    nd.append(ndcg(ranked, gains))
    by_difficulty[q["difficulty"]].append(recall[5][-1])
    for r in req - set(ranked[:10]):
      missed[r] += 1

  # Negatives: nothing should come back looking confident.
  leaked, top_scores = 0, []
  for q in negatives:
    hits = engine.search(q["question"], limit=5)
    top_scores.append(hits[0][0] if hits else 0.0)
    if set(r for _, r in hits) & set(q["forbidden"]):
      leaked += 1

  mean = lambda xs: (sum(xs) / len(xs)) if xs else 0.0
  print(f"\n=== {label} ===")
  print(f"  indexed entries           {len(index)}")
  print(f"  answerable questions      {len(answerable)}")
  for k in CUTOFFS:
    print(
        f"  recall@{k:<2}                 {mean(recall[k]):.3f}"
        f"    all-required@{k:<2} {mean(full[k]):.3f}"
    )
  print(f"  MRR                       {mean(rr):.3f}")
  print(f"  nDCG@10                   {mean(nd):.3f}")
  print(
      "  recall@5 by difficulty    "
      + "  ".join(
          f"{d} {mean(by_difficulty[d]):.3f}"
          for d in ("easy", "medium", "hard")
      )
  )
  print(f"\n  negatives                 {len(negatives)}")
  print(
      f"  forbidden entry in top-5  {leaked}/{len(negatives)}"
      "   (lower is better; BM25 cannot abstain)"
  )
  if missed:
    print("\n  most-missed required entries (absent from top-10):")
    for ref, n in missed.most_common(6):
      print(f"    {n}x  {ref}")
  return {"recall@5": mean(recall[5]), "ndcg": mean(nd), "mrr": mean(rr)}


def main():
  ap = argparse.ArgumentParser()
  ap.add_argument(
      "--with-synonyms",
      action="store_true",
      help="index ai_context.synonyms, which the KC push drops",
  )
  ap.add_argument(
      "--compare",
      action="store_true",
      help="run both ways and report the synonym gap",
  )
  args = ap.parse_args()

  questions = load_questions()
  if args.compare:
    a = evaluate(
        build_index(False), questions, "as KC indexes today (no synonyms)"
    )
    b = evaluate(build_index(True), questions, "with synonyms indexed")
    print("\n=== what indexing synonyms would buy ===")
    for key in ("recall@5", "mrr", "ndcg"):
      d = b[key] - a[key]
      print(f"  {key:<10} {a[key]:.3f} -> {b[key]:.3f}   ({d:+.3f})")
    print()
    return
  label = (
      "with synonyms indexed"
      if args.with_synonyms
      else "as KC indexes today (no synonyms)"
  )
  evaluate(build_index(args.with_synonyms), questions, label)
  print()


if __name__ == "__main__":
  sys.exit(main())
