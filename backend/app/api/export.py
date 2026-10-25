"""Safe export endpoints. Output only goes into the configured output folder;
source libraries are never written to."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..config import get_settings
from ..db import get_session
from ..models import DJSet, SetTrack, Track
from ..schemas import ExportRequest
from ..services import backup, exporter_csv, exporter_m3u, exporter_markdown

router = APIRouter(prefix="/export", tags=["export"])


def _resolve_tracks(session: Session, req: ExportRequest) -> list[Track]:
    if req.set_id is not None:
        links = session.exec(
            select(SetTrack).where(SetTrack.set_id == req.set_id).order_by(SetTrack.position)
        ).all()
        tracks = [session.get(Track, link.track_id) for link in links]
        return [t for t in tracks if t is not None]
    if req.track_ids:
        tracks = [session.get(Track, tid) for tid in req.track_ids]
        return [t for t in tracks if t is not None]
    if req.all_tracks:
        return session.exec(
            select(Track).where(Track.missing.is_(False)).order_by(Track.artist, Track.title)
        ).all()
    return []


def _dest(filename: str, default: str):
    out_dir = get_settings().output_path
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / (filename or default)


@router.post("/m3u")
def export_m3u(req: ExportRequest, session: Session = Depends(get_session)):
    tracks = _resolve_tracks(session, req)
    if not tracks:
        raise HTTPException(400, "no tracks to export")
    dest = _dest(req.filename or "", "cratemind.m3u8")
    try:
        path = exporter_m3u.export_m3u(tracks, dest, req.overwrite)
    except FileExistsError as exc:
        raise HTTPException(409, str(exc))
    return {"path": str(path), "count": len(tracks)}


@router.post("/csv")
def export_csv(req: ExportRequest, session: Session = Depends(get_session)):
    tracks = _resolve_tracks(session, req)
    if not tracks:
        raise HTTPException(400, "no tracks to export")
    dest = _dest(req.filename or "", "cratemind.csv")
    try:
        path = exporter_csv.export_csv(session, tracks, dest, req.overwrite)
    except FileExistsError as exc:
        raise HTTPException(409, str(exc))
    return {"path": str(path), "count": len(tracks)}


@router.post("/markdown")
def export_markdown(req: ExportRequest, session: Session = Depends(get_session)):
    if req.set_id is None:
        raise HTTPException(400, "markdown export requires set_id")
    dj_set = session.get(DJSet, req.set_id)
    if dj_set is None:
        raise HTTPException(404, "set not found")
    tracks = _resolve_tracks(session, req)
    dest = _dest(req.filename or "", f"set-{req.set_id}.md")
    try:
        path = exporter_markdown.export_markdown(dj_set, tracks, dest, req.overwrite)
    except FileExistsError as exc:
        raise HTTPException(409, str(exc))
    return {"path": str(path), "count": len(tracks)}


@router.post("/json-backup")
def export_json_backup(req: ExportRequest, session: Session = Depends(get_session)):
    dest = _dest(req.filename or "", "cratemind-backup.json")
    path = backup.export_json(session, dest, overwrite=True)
    return {"path": str(path)}
