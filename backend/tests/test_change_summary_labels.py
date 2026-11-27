"""The import preview's change summary names each table in Greek (hermetic: no database is read)."""
from __future__ import annotations

from app.library_exchange import operations


def test_tag_writes_has_its_own_greek_label(tmp_path, monkeypatch):
    for side in ("local", "incoming"):
        (tmp_path / side).mkdir()
        (tmp_path / side / "catalog.sqlite").write_bytes(b"")
    values = {"local": {}, "incoming": {"tag_writes": [{"id": 1, "status": "done"}], "jobs_unlabelled": [{"id": 1}]}}
    monkeypatch.setattr(operations, "canonical_database_values", lambda path: values[path.parent.name])
    rows = {row["table"]: row["label"] for row in operations._change_summary(tmp_path / "local", tmp_path / "incoming")}
    assert rows == {"tag_writes": "Εγγραφές tags σε αρχεία", "jobs_unlabelled": "Άλλα στοιχεία βιβλιοθήκης"}
