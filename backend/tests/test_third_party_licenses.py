"""The licence inventory's --check gate: allowlist matching and exit codes, on hand-built rows."""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("third_party_licenses", ROOT / "scripts/third_party_licenses.py")
tpl = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tpl)


def row(source, name, licence, ships=True):
    return tpl.entry(source, name, "", licence, ships=ships)


ALLOW = [
    {"source": "Python", "name": "mutagen", "class": "strong-copyleft"},
    {"source": "Media tools", "name": "libav*", "class": "strong-copyleft"},
    {"source": "Rust", "name": "selectors", "class": "weak-copyleft"},
]


def test_allowlisted_permissive_and_unshipped_rows_pass():
    rows = [row("Python", "mutagen", "GPL-2.0-or-later"), row("Media tools", "libavcodec.63.24.100.dylib", "GPL-3.0-or-later"),
            row("Python", "numpy", "BSD-3-Clause"), row("Vendored", "master_me", "GPL-3.0", ships=False),
            row("Rust", "Selectors", "MPL-2.0")]
    assert tpl.unlisted(rows, ALLOW) == []


def test_new_name_other_source_or_worse_class_is_unlisted():
    rows = [row("Python", "somegpl", "GPL-3.0"), row("Rust", "mutagen", "GPL-2.0-or-later"),
            row("Rust", "selectors", "GPL-3.0-only"), row("Python", "mutagen", "MIT AND Commons Clause")]
    assert [(r["source"], r["name"], r["class"]) for r in tpl.unlisted(rows, ALLOW)] == [
        ("Python", "somegpl", "strong-copyleft"), ("Rust", "mutagen", "strong-copyleft"),
        ("Rust", "selectors", "strong-copyleft"), ("Python", "mutagen", "noncommercial")]


def test_a_better_class_than_allowed_passes():
    assert tpl.unlisted([row("Python", "mutagen", "LGPL-2.1-or-later")], ALLOW) == []


def test_committed_allowlist_is_well_formed():
    allow = json.loads(tpl.ALLOWLIST.read_text())["allow"]
    assert allow
    for a in allow:
        assert a["source"] in tpl.CHECKED + ("Vendored",)
        assert a["class"] in tpl.FLAGGED
        assert a["why"].strip()
    assert not any("master_me" in a["name"] for a in allow)  # personal builds only, never an approved shipment


@pytest.mark.parametrize("rows, code", [
    ([row(s, "ok", "MIT") for s in tpl.CHECKED], 0),
    ([row(s, "ok", "MIT") for s in tpl.CHECKED] + [row("Python", "somegpl", "GPL-3.0")], 1),
    ([row(s, "ok", "MIT") for s in tpl.CHECKED if s != "Rust"], 2),
    ([row("Python", "somegpl", "GPL-3.0")], 1),
])
def test_check_exit_codes(monkeypatch, tmp_path, capsys, rows, code):
    allow = tmp_path / "allow.json"
    allow.write_text(json.dumps({"allow": ALLOW}))
    for name in ("python_entries", "js_entries", "rust_entries", "media_entries"):
        monkeypatch.setattr(tpl, name, lambda *a: [])
    monkeypatch.setattr(tpl, "vendored_entries", lambda *a: rows)
    monkeypatch.setattr(sys, "argv", ["third_party_licenses.py", "--check", str(allow)])
    assert tpl.main() == code
    out = capsys.readouterr().out
    assert ("somegpl" in out) == (code == 1)
    assert ("Could not check" in out) == (len({r["source"] for r in rows}) < len(tpl.CHECKED))
