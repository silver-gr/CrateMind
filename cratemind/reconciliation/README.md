# Offline collection preview

This staging utility reads source archives and a SQLite online backup. It does not import the application, invoke its startup/migration hooks, log plays, or make cloud requests. Production code remains unchanged.

Run from CrateMind with the existing Python environment:

```sh
/Users/silver/venv/bin/python reconciliation/preview.py --output reconciliation/runs/NEW-RUN
/Users/silver/venv/bin/python -m unittest discover -s reconciliation -p 'test_preview.py' -v
```

For a deterministic rerun, pass the original consistent snapshot explicitly:

```sh
/Users/silver/venv/bin/python reconciliation/preview.py --output reconciliation/runs/20260914-preview --snapshot reconciliation/runs/20260914-preview/catalog_snapshot.sqlite
```

Only reuse a preview-owned output directory. Source artifacts and snapshots are not overwritten. The completed milestone is under `runs/20260914-preview/`; start with `RECONCILIATION_SUMMARY.md` or open `collection_preview.html`. Audio controls use the existing local backend's read-only audio route. Editing the proposed name only changes the current browser page; it does not save to the catalog.

Fixture tests run anywhere; snapshot acceptance tests additionally run when the dated preview output is present. No dependencies added. Large staging outputs are ignored by Git and kept local with an owner-only output directory.
