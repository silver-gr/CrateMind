"""Legacy source schemas observed before Tauri, always exercised on fixtures."""
import sqlite3

from sqlmodel import Session, create_engine

from app.library_exchange.operations import _schema_initialize
from app.models import ArtistProfile, ArtistReview
from app.services.schema_contract import load_schema_contract, validate_schema_compatibility


def test_private_upgrade_preserves_old_artist_energy_values_and_reviews(tmp_path):
    catalog = tmp_path / "catalog.sqlite"
    with sqlite3.connect(catalog) as db:
        for sql in load_schema_contract()["initialization_sql"]["catalog"]:
            db.execute(sql.replace('energy_min FLOAT', 'energy_min INTEGER').replace('energy_max FLOAT', 'energy_max INTEGER'))
    engine = create_engine(f"sqlite:///{catalog}")
    with Session(engine) as session:
        profile = ArtistProfile(normalized_name="fixture", canonical_name="Fixture", energy_min=3.5, energy_max=9)
        session.add(profile)
        session.commit()
        session.add(ArtistReview(artist_id=profile.id, baseline_json='{"human":"preserved"}'))
        session.commit()
    engine.dispose()
    with sqlite3.connect(catalog) as db:
        before = db.execute('SELECT * FROM artist_profiles').fetchall()
        reviews = db.execute('SELECT * FROM artist_reviews').fetchall()
    _schema_initialize(catalog, None)
    validate_schema_compatibility(catalog)
    with sqlite3.connect(catalog) as db:
        assert db.execute('SELECT * FROM artist_profiles').fetchall() == before
        assert db.execute('SELECT * FROM artist_reviews').fetchall() == reviews
        assert db.execute('PRAGMA foreign_key_check').fetchall() == []
        assert {r[1]: r[2] for r in db.execute('PRAGMA table_info(artist_profiles)')}['energy_min'] == 'FLOAT'


def test_runtime_identity_indexes_are_in_supported_contract():
    indices = load_schema_contract()['normalized_identity_schema']['tables']['entities']['indices']
    sql = [item['sql'] or '' for item in indices]
    assert any('entities_local_track_id' in value for value in sql)
    assert any('entities_recording_service' in value for value in sql)


def test_scan_scope_can_be_narrower_than_portable_volume_mapping(tmp_path):
    import json
    from app.config import Settings
    volume = tmp_path / 'volume'
    music = volume / 'Music'
    music.mkdir(parents=True)
    config = tmp_path / 'mappings.json'
    config.write_text(json.dumps({'version': 1, 'library_roots': [{
        'root_key': 'volume', 'logical_prefix': '/original-volume', 'logical_flavor': 'posix',
        'local_prefix': str(volume), 'enabled': True}]}))
    settings = Settings(_env_file=None, path_mappings_file=str(config),
                        scan_roots=['/original-volume/Music'])
    assert settings.roots == [music]
    music.rmdir()
    assert settings.roots == []  # never widen a disconnected scan to the volume
