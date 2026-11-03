#!/usr/bin/env python3
"""Validate migration scope; inventory coverage is not behavioral parity.

The default check is stdlib-only and never imports the backend. Optional runtime
discovery imports an app in a child process with private temporary settings; it
does not enter the lifespan, execute handlers, start jobs, or scan any library.
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / "docs/superpowers/specs/2026-10-27-tauri-parity-baseline.json"
ACCEPTANCE = ROOT / "backend/tests/fixtures/desktop_parity/acceptance.json"
BASELINE_COMMIT = "f71dc17ac596732ab14c3e81d9fe984210733c62"
# Authenticated native-supervisor readiness, not a public product API contract.
INTERNAL_DESKTOP_ROUTES = {"GET /api/desktop/health"}
# Separately authorized product work after the approved migration scope. Never
# append these to the historical 104-route capture or its nine migration tasks.
FOLLOWUP_ROUTES = [{
    "method": "GET",
    "path": "/api/tracks/{track_id}/playback-loudness",
    "profiles": ["web", "desktop-core"],
    "desktop_guard": "read_source_cache_only",
    "verification_owner": "playback_loudness",
    "oracle": ("backend/tests/test_playback_loudness.py::"
               "test_route_status_shape_missing_source_busy_and_catalog_untouched"),
}, {
    "method": "GET",
    "path": "/api/tracks/{track_id}/waveform/detail",
    "profiles": ["web", "desktop-core"],
    "desktop_guard": "read_source_cache_only",
    "verification_owner": "waveform_detail",
    "oracle": "backend/tests/test_waveform_detail.py::test_route_etag_304_and_cache_headers",
}, {
    "method": "GET",
    "path": "/api/tracks/{track_id}/waveform/density",
    "profiles": ["web", "desktop-core"],
    "desktop_guard": "read_source_cache_only",
    "verification_owner": "waveform_density",
    "oracle": "backend/tests/test_waveform_density.py::test_route_density_geometry_busy_etag_and_stale_detail",
}, {
    "method": "GET",
    "path": "/api/tracks/{track_id}/beatgrid",
    "profiles": ["web", "desktop-core"],
    "desktop_guard": "read_source_cache_only",
    "verification_owner": "djay_import",
    "oracle": "backend/tests/test_djay_import.py::test_beatgrid_route_returns_stored_grid_or_404",
}, {
    "method": "GET",
    "path": "/api/import/djay",
    "profiles": ["web", "desktop-core"],
    "desktop_guard": "read_source_cache_only",
    "verification_owner": "djay_import",
    "oracle": "backend/tests/test_djay_import.py::test_import_job_end_to_end_and_remove",
}, {
    # Mutations act only on CrateMind's own track_beatgrids table; djay's files
    # are only ever read (library from a private copy, plists in place).
    "method": "POST",
    "path": "/api/import/djay",
    "profiles": ["web", "desktop-core"],
    "desktop_guard": "allow_shared",
    "verification_owner": "djay_import",
    "oracle": "backend/tests/test_djay_import.py::test_import_job_end_to_end_and_remove",
}, {
    "method": "DELETE",
    "path": "/api/import/djay",
    "profiles": ["web", "desktop-core"],
    "desktop_guard": "allow_shared",
    "verification_owner": "djay_import",
    "oracle": "backend/tests/test_djay_import.py::test_remove_deletes_only_djay_rows_and_is_rejected_while_busy",
}, {
    # Mutations act only on CrateMind's own track_downbeats table.
    "method": "GET",
    "path": "/api/tracks/{track_id}/downbeat",
    "profiles": ["web", "desktop-core"],
    "desktop_guard": "read_source_cache_only",
    "verification_owner": "track_downbeat",
    "oracle": "backend/tests/test_track_downbeat.py::test_downbeat_round_trip_and_validation",
}, {
    "method": "POST",
    "path": "/api/tracks/{track_id}/downbeat",
    "profiles": ["web", "desktop-core"],
    "desktop_guard": "allow_shared",
    "verification_owner": "track_downbeat",
    "oracle": "backend/tests/test_track_downbeat.py::test_downbeat_round_trip_and_validation",
}, {
    "method": "DELETE",
    "path": "/api/tracks/{track_id}/downbeat",
    "profiles": ["web", "desktop-core"],
    "desktop_guard": "allow_shared",
    "verification_owner": "track_downbeat",
    "oracle": "backend/tests/test_track_downbeat.py::test_downbeat_round_trip_and_validation",
}, {
    # Manual «×½ / ×2» fix: writes only the CrateMind consensus columns plus an
    # audit row; never tags, audio or djay data.
    "method": "POST",
    "path": "/api/tracks/{track_id}/bpm",
    "profiles": ["web", "desktop-core"],
    "desktop_guard": "allow_shared",
    "verification_owner": "manual_bpm",
    "oracle": "backend/tests/test_manual_bpm.py::test_desktop_core_routes_without_dsp",
}, {
    "method": "DELETE",
    "path": "/api/tracks/{track_id}/bpm",
    "profiles": ["web", "desktop-core"],
    "desktop_guard": "allow_shared",
    "verification_owner": "manual_bpm",
    "oracle": "backend/tests/test_manual_bpm.py::test_reset_recomputes_auto",
}, {
    # Read-only folder list for the triage queue's folder picker.
    "method": "GET",
    "path": "/api/tracks/folders",
    "profiles": ["web", "desktop-core"],
    "desktop_guard": "read_source_cache_only",
    "verification_owner": "triage",
    "oracle": "backend/tests/test_triage_routes.py::test_folders_route_groups_normalised_parents",
}] + [{
    # User vocabularies: writes touch only CrateMind's own facets/tags/track_tags.
    "method": method,
    "path": path,
    "profiles": ["web", "desktop-core"],
    "desktop_guard": "read_source_cache_only" if method == "GET" else "allow_shared",
    "verification_owner": "facets",
    "oracle": "backend/tests/test_facet_routes.py::test_facet_routes_crud_and_counts",
} for method, path in (
    ("GET", "/api/facets"),
    ("POST", "/api/facets"),
    ("POST", "/api/facets/{facet_id}"),
    ("DELETE", "/api/facets/{facet_id}"),
    ("POST", "/api/facets/{facet_id}/values"),
    ("POST", "/api/facets/values/{value_id}"),
    ("DELETE", "/api/facets/values/{value_id}"),
    ("POST", "/api/facets/presets/{name}"),
    ("GET", "/api/facets/counts"),
)]
# Separately authorized changes to a captured route's desktop disposition. They
# are applied to copies by effective_routes(); the historical capture keeps its
# original classification.
RECLASSIFIED_ROUTES = [{
    # Desktop analyses BPM/key locally; providers and the BPM review stay web-only.
    "method": "POST",
    "path": "/api/scan/analyze",
    "from_disposition": "deferred_to_web",
    "desktop_disposition": "retain_shared_implementation",
    "desktop_guard": "allow_shared",
    "verification_owner": "desktop_local_analysis",
    "oracle": "backend/tests/test_desktop_analysis.py::test_desktop_analyze_route_starts_a_job",
    "authorized": "user, 2026-11-02",
}]


def route_key(route: dict) -> str:
    # Names are implementation details; Starlette converters affect matching.
    path = re.sub(r"\{[^}:]+(?::([^}]+))?\}",
                  lambda match: "{" + (match[1] or "str") + "}", route["path"])
    return f"{route['method'].upper()} {path}"


def keyed(routes: list[dict], label: str) -> dict[str, dict]:
    result = {}
    for route in routes:
        key = route_key(route)
        if key in result:
            raise ValueError(f"{label}: duplicate normalized route {key}")
        result[key] = route
    return result


def validate_oracle(reference: str, root: Path) -> None:
    path, _, test_name = reference.partition("::")
    source = root / path
    if not source.is_file():
        raise ValueError(f"Missing oracle: {reference}")
    if source.suffix == ".py" and test_name:
        tree = ast.parse(source.read_text())
        names = {node.name for node in ast.walk(tree)
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
        if test_name not in names:
            raise ValueError(f"Missing oracle test: {reference}")


def validate_followups(baseline: dict, root: Path = ROOT) -> dict[str, dict]:
    """Keep post-migration additions explicit, owned, and independently verified."""
    followups = keyed(FOLLOWUP_ROUTES, "follow-up")
    historical = set(keyed(baseline["routes"], "baseline")) | set(
        keyed(baseline["planned_routes"], "planned"))
    if set(followups) & historical:
        raise ValueError("Follow-up routes overlap the approved migration scope")
    for key, route in followups.items():
        guard = "read_source_cache_only" if route["method"] == "GET" else "allow_shared"
        if (route["method"] not in {"GET", "POST", "DELETE"}
                or set(route["profiles"]) != {"web", "desktop-core"}
                or route["desktop_guard"] != guard
                or not route.get("verification_owner") or not route.get("oracle")):
            raise ValueError(f"Unclassified or unowned follow-up contract: {key}")
        validate_oracle(route["oracle"], root)
    return followups


def effective_routes(baseline: dict, root: Path = ROOT) -> list[dict]:
    """Return copies of the captured routes with authorized reclassifications applied."""
    routes = [dict(route) for route in baseline["routes"]]
    by_key = keyed(routes, "baseline")
    for key, change in keyed(RECLASSIFIED_ROUTES, "reclassified").items():
        route = by_key.get(key)
        if route is None or route["desktop_disposition"] != change["from_disposition"]:
            raise ValueError(f"Reclassification does not match the captured route: {key}")
        if not change.get("verification_owner") or not change.get("authorized"):
            raise ValueError(f"Unowned or unauthorized reclassification: {key}")
        validate_oracle(change["oracle"], root)
        route.update(desktop_disposition=change["desktop_disposition"],
                     desktop_guard=change["desktop_guard"])
    return routes


def validate_inventory(baseline: dict, acceptance: dict, root: Path = ROOT) -> dict:
    """Validate classification and acceptance ownership without importing app code."""
    routes = keyed(effective_routes(baseline, root), "baseline")
    planned = keyed(baseline["planned_routes"], "planned")
    mapped = keyed(acceptance["routes"], "acceptance")
    if baseline["git_commit"] != BASELINE_COMMIT or acceptance["baseline_commit"] != BASELINE_COMMIT:
        raise ValueError("Inventory must reference the approved source baseline")
    if len(routes) != 104 or len(planned) != 9:
        raise ValueError("Approved scope is 104 baseline and 9 separately planned routes")
    if set(routes) & set(planned):
        raise ValueError("Planned routes overlap the captured baseline")
    if set(mapped) != set(routes):
        raise ValueError(f"Route mapping drift: missing={sorted(set(routes) - set(mapped))}; "
                         f"extra={sorted(set(mapped) - set(routes))}")
    groups = acceptance["behaviors"]
    deferred = 0
    for key, route in routes.items():
        retained = route["desktop_disposition"] == "retain_shared_implementation"
        if not retained and route["desktop_disposition"] != "deferred_to_web":
            raise ValueError(f"Unknown disposition: {key}")
        deferred += not retained
        guard = route["desktop_guard"]
        if guard not in baseline["guard_semantics"]:
            raise ValueError(f"Unclassified guard: {key}")
        if (not retained) != (guard == "web_only"):
            raise ValueError(f"Disposition/guard mismatch: {key}")
        if route["method"] not in {"GET", "HEAD"} and guard == "read_shared":
            raise ValueError(f"Mutation has a read guard: {key}")
        mapping = mapped[key]
        if not mapping.get("verification_owner") or mapping.get("desktop_guard") != guard:
            raise ValueError(f"Missing owner or changed guard: {key}")
        behavior = groups.get(mapping["behavior"])
        if not behavior or not behavior.get("acceptance") or not behavior.get("pending"):
            raise ValueError(f"Missing behavior acceptance: {key}")
        if retained and not behavior.get("oracles"):
            raise ValueError(f"Retained behavior has no oracle: {key}")
        if not retained and mapping.get("capability") not in {"analysis", "provider_workflows"}:
            raise ValueError(f"Deferred route has no capability gate: {key}")
    # The capture deferred 12 routes; each reclassification retains one of them.
    expected_deferred = 12 - len(RECLASSIFIED_ROUTES)
    if deferred != expected_deferred:
        raise ValueError(f"Expected exactly {expected_deferred} deferred routes, got {deferred}")
    planned_mapping = keyed(acceptance["planned_routes"], "planned acceptance")
    if planned_mapping != planned:
        raise ValueError("Planned routes/profiles/tasks/guards differ from approved baseline")
    for behavior in groups.values():
        if behavior["oracle_scope"] not in {"api", "service", "partial", "future"}:
            raise ValueError("Oracle scope must disclose the existing coverage boundary")
        for reference in behavior["oracles"]:
            validate_oracle(reference, root)
    source = (root / "frontend/src/app/App.tsx").read_text()
    screen_paths = re.findall(r'<Route\s+path="([^"]+)"', source)
    screens = acceptance["screens"]
    if len(screen_paths) != len(set(screen_paths)) or set(screen_paths) != set(screens):
        raise ValueError("Unclassified or removed frontend route/screen")
    for path, screen in screens.items():
        if not screen.get("verification_owner") or not screen.get("acceptance"):
            raise ValueError(f"Missing screen acceptance: {path}")
        if not (root / screen["source"]).is_file():
            raise ValueError(f"Missing screen source: {path}")
        for behavior in screen["behaviors"]:
            if behavior not in groups:
                raise ValueError(f"Unknown screen behavior: {path}/{behavior}")
        if screen["status"] == "placeholder":
            if "ComingSoon" not in (root / screen["source"]).read_text():
                raise ValueError(f"Placeholder grew into unreviewed roadmap scope: {path}")
        elif screen["status"] not in {"retained", "redirect"}:
            raise ValueError(f"Unclassified screen status: {path}")
    validate_followups(baseline, root)
    return {"baseline_routes": len(routes), "retained_routes": len(routes) - deferred,
            "deferred_routes": deferred, "planned_routes": len(planned),
            "screens": len(screens), "behavioral_parity": "not established by inventory"}


def compare_runtime(baseline: dict, actual: list[dict], profile: str) -> dict:
    """Allow only baseline, planned migration, and explicitly owned follow-up routes.

    Deferred routes may be registered as 501 stubs or omitted by desktop-core.
    This structural check deliberately cannot prove a stub's response or guard.
    """
    observed = keyed(actual, "runtime")
    routes = keyed(effective_routes(baseline), "baseline")
    required = {key for key, route in routes.items()
                if profile != "desktop-core" or route["desktop_disposition"] != "deferred_to_web"}
    additions = {route_key(route) for route in baseline["planned_routes"]
                 if profile in route["profiles"]}
    followups = {key for key, route in validate_followups(baseline).items()
                 if profile in route["profiles"]}
    internal = INTERNAL_DESKTOP_ROUTES if profile == "desktop-core" else set()
    missing = required - set(observed)
    extra = set(observed) - set(routes) - additions - followups - internal
    if missing or extra:
        raise ValueError(f"{profile} runtime route drift: missing={sorted(missing)}; "
                         f"unclassified={sorted(extra)}")
    return {"profile": profile, "observed_routes": len(observed),
            "planned_present": sorted(set(observed) & additions),
            "followup_present": sorted(set(observed) & followups),
            "internal_present": sorted(set(observed) & internal)}


def discover_runtime(profile: str) -> list[dict]:
    with tempfile.TemporaryDirectory(prefix="cratemind-parity-") as directory:
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("CRATEMIND_")}
        env.update(PYTHONPATH=str(ROOT / "backend"), NUMBA_CACHE_DIR=f"{directory}/numba")
        output = Path(directory) / "routes.json"
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--_discover", profile,
             "--_storage", directory], env=env, cwd=directory,
            capture_output=True, text=True, timeout=90, check=False,
        )
        if result.returncode:
            raise ValueError(f"Isolated runtime discovery failed: {result.stderr.strip()}")
        return json.loads(output.read_text())


def _discover(profile: str, directory: str) -> None:
    # Executed only in the child, before any app.db or router import.
    import socket
    from functools import lru_cache

    root = Path(directory).resolve()
    os.environ.update(CRATEMIND_DB_PATH=str(root / "catalog.sqlite"),
                      CRATEMIND_IDENTITY_DB_PATH=str(root / "identity.sqlite"),
                      CRATEMIND_BACKUP_DIR=str(root / "backups"),
                      CRATEMIND_OUTPUT_DIR=str(root / "exports"),
                      CRATEMIND_LIBRARY_ROOTS=str(root / "empty-library"),
                      CRATEMIND_RUNTIME_PROFILE=profile)
    from app import config

    @lru_cache
    def isolated_settings():
        return config.Settings(_env_file=None)

    config.get_settings = isolated_settings

    def no_network(*args, **kwargs):
        raise RuntimeError("Network use is forbidden during route discovery")

    socket.socket.connect = no_network
    socket.socket.connect_ex = no_network
    import importlib.util

    if importlib.util.find_spec("app.app_factory"):
        from app.app_factory import create_app
        from app.runtime_profile import RuntimeProfile

        app = create_app(profile=RuntimeProfile(profile))
    elif profile == "web":
        from app.main import app
    else:
        raise ValueError("desktop-core factory is not implemented yet")
    settings = config.get_settings()
    for path in (settings.db_file, settings.backup_path, settings.output_path, *settings.roots):
        if not path.resolve().is_relative_to(root):
            raise ValueError("Runtime discovery escaped private storage")
    routes = []
    for route in app.routes:
        # FastAPI 0.139 retains included routers lazily. Effective contexts
        # preserve their prefixes and include routes hidden from OpenAPI too.
        contexts = getattr(route, "effective_route_contexts", None)
        candidates = ((context.path, context.original_route) for context in contexts()) \
            if contexts else [(getattr(route, "path", ""), route)]
        for path, candidate in candidates:
            if path.startswith("/api/"):
                routes.extend({"method": method, "path": path}
                              for method in sorted(getattr(candidate, "methods", set())))
    (root / "routes.json").write_text(json.dumps(routes))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", choices=["web", "desktop-core"])
    parser.add_argument("--_discover", help=argparse.SUPPRESS)
    parser.add_argument("--_storage", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args._discover:
        _discover(args._discover, args._storage)
        return 0
    try:
        baseline = json.loads(BASELINE.read_text())
        report = validate_inventory(baseline, json.loads(ACCEPTANCE.read_text()))
        if args.runtime:
            report["runtime"] = compare_runtime(baseline, discover_runtime(args.runtime), args.runtime)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, KeyError, OSError, subprocess.TimeoutExpired) as error:
        print(f"Parity inventory failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
