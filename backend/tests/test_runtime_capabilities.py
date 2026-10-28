from app.models import Track


def test_python_capabilities_are_explicit_and_json_import_unavailable(client, tmp_path, monkeypatch):
    monkeypatch.delenv('CRATEMIND_IDENTITY_DB_PATH', raising=False)
    response = client.get('/api/capabilities')
    assert response.status_code == 200
    assert response.json() == {'identity': False, 'analysis': True, 'artist_enrichment': True, 'backup_import': False, 'complete_backup': True, 'provider_workflows': True, 'library_exchange': False, 'native_dialogs': False}
    (tmp_path / 'identity.sqlite').touch()
    assert client.get('/api/capabilities').json()['identity'] is True


def test_export_all_tracks_is_explicit_and_excludes_missing(db):
    from app.api.export import _resolve_tracks
    from app.schemas import ExportRequest

    a = Track(absolute_path='/lib/a.wav', artist='B', title='Two')
    b = Track(absolute_path='/lib/b.wav', artist='A', title='One')
    missing = Track(absolute_path='/lib/missing.wav', artist='C', missing=True)
    db.add_all([a, b, missing])
    db.commit()
    assert _resolve_tracks(db, ExportRequest()) == []
    assert [track.id for track in _resolve_tracks(db, ExportRequest(all_tracks=True))] == [b.id, a.id]
    assert [track.id for track in _resolve_tracks(db, ExportRequest(all_tracks=True, track_ids=[a.id]))] == [a.id]


def test_explicit_broken_identity_installation_stays_visible_and_read_errors_surface(client, tmp_path, monkeypatch):
    monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH', str(tmp_path / 'broken-explicit.sqlite'))
    assert client.get('/api/capabilities').json()['identity'] is True
    assert client.get('/api/identity/summary').status_code == 503


def test_csv_endpoint_accepts_explicit_all_tracks_request(client):
    from pathlib import Path

    from sqlmodel import Session

    from app.db import get_engine

    with Session(get_engine()) as session:
        session.add_all([
            Track(absolute_path='/lib/available.wav', title='Available'),
            Track(absolute_path='/lib/missing.wav', title='Missing', missing=True),
        ])
        session.commit()
    response = client.post('/api/export/csv', json={'all_tracks': True})
    assert response.status_code == 200
    assert response.json()['count'] == 1
    content = Path(response.json()['path']).read_text()
    assert 'Available' in content and 'Missing' not in content
