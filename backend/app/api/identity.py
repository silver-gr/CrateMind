"""Nonmutating unified-library endpoints; all data comes from the identity extension."""
import sqlite3
import json
from pathlib import Path
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import HTMLResponse
from ..services import identity_library
from ..runtime_profile import RuntimeProfile, get_runtime_profile

router = APIRouter(prefix='/identity', tags=['identity'])
CALIBRATION_DIR = Path(__file__).resolve().parents[3] / 'reconciliation' / 'identity'


def require_local_pair(left_id: str, right_id: str) -> None:
    if get_runtime_profile() is not RuntimeProfile.DESKTOP_CORE:
        return
    try:
        with identity_library.connect() as db:
            rows = db.execute("SELECT id, service FROM entities WHERE id IN (?, ?)",
                              (left_id, right_id)).fetchall()
    except sqlite3.Error as exc:
        raise HTTPException(503, 'Η ενοποιημένη βιβλιοθήκη δεν είναι διαθέσιμη.') from exc
    services = {row['id']: row['service'] for row in rows}
    if any(services.get(entity_id) != 'local' for entity_id in (left_id, right_id)):
        from ..runtime_errors import WebWorkflowRequired
        raise WebWorkflowRequired()


def read(operation, *args, **kwargs):
    try:
        with identity_library.connect() as db:
            result = operation(db, *args, **kwargs)
    except sqlite3.OperationalError as exc:
        raise HTTPException(503, 'Η ενοποιημένη βιβλιοθήκη δεν είναι διαθέσιμη ακόμη.') from exc
    if result is None:
        raise HTTPException(404, 'Δεν βρέθηκε')
    return result


@router.get('/summary')
def summary():
    return read(identity_library.summary)


@router.get('/items')
def items(q: str = '', service: str = '', category: str = '', limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0), mode: str = 'recordings'):
    return read(identity_library.list_items, q, service, category, limit, offset, mode)


@router.get('/item')
def item(id: str, candidate: str=""):
    return read(identity_library.detail, id, candidate)


@router.get('/collections')
def collections():
    return read(identity_library.collections)


@router.get('/collection')
def collection(id: str, original: bool=False):
    from ..services.collection_intelligence import enrich_collection
    def load(db):
        from ..services.collection_consolidation import projection
        targets=projection(db)['mapping'].get(id,set())
        resolved=next(iter(targets)) if not original and len(targets)==1 else id
        result=enrich_collection(db,identity_library.collection(db,resolved))
        if result is not None:result.update(requested_id=id,representative_ids=sorted(targets),original_view=original)
        return result
    return read(load)


@router.get('/calibration', response_class=HTMLResponse)
def calibration():
    try:
        report = json.loads((CALIBRATION_DIR / 'calibration.json').read_text())
        page = (CALIBRATION_DIR / 'calibration.html').read_text()
    except (OSError, ValueError) as exc:
        raise HTTPException(503, 'Ο έλεγχος αντιστοιχίσεων δεν είναι διαθέσιμος ακόμη.') from exc
    if report.get('projection_build_at') != read(identity_library.summary).get('built_at'):
        raise HTTPException(503, 'Ο έλεγχος χρειάζεται ενημέρωση για τη νέα βιβλιοθήκη.')
    return HTMLResponse(page, headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})

# Canonical metadata decisions mutate only the local identity catalog.
from pydantic import BaseModel, Field
from typing import Literal
from ..services import canonical_library

class MetadataDecision(BaseModel):
    recording_id: str
    action: Literal['accept', 'edit', 'reject', 'keep_local']
    payload: dict | None = None

class PatternDecision(BaseModel):
    pattern: str

class RevokeDecision(BaseModel):
    left_id: str
    right_id: str

@router.get('/canonical/items')
def canonical_items(q: str = '', state: str = '', pattern: str = '', artist_id: str = '', role: str = '', offset: int = Query(0, ge=0), view: Literal['needs_review','auto_applied','conflicts','provider_only','local_only','complete','unknown','all'] = 'needs_review'):
    from ..services.canonical_queue import list_items
    return read(list_items,q,state,pattern,artist_id,role,offset,view)

@router.get('/canonical/item')
def canonical_item(id: str):
    return read(canonical_library.detail,id)

@router.get('/canonical/patterns')
def canonical_patterns():
    def load(db):
        return [{'pattern':r['pattern'],**json.loads(r['report_json'])} for r in db.execute('SELECT * FROM canonical_patterns ORDER BY pattern')]
    return read(load)

@router.get('/canonical/artists')
def canonical_artists(q: str = ''):
    def load(db):
        return [dict(r) for r in db.execute('SELECT a.id,a.name,count(DISTINCT ra.recording_id) AS recordings FROM canonical_artists a JOIN recording_artists ra ON ra.artist_id=a.id WHERE a.name LIKE ? GROUP BY a.id ORDER BY recordings DESC,a.name LIMIT 100',('%'+q+'%',))]
    return read(load)

def write_canonical(operation,*args):
    try:
        with canonical_library.connect() as db:return operation(db,*args)
    except ValueError as e:raise HTTPException(400,str(e)) from e
    except sqlite3.OperationalError as e:raise HTTPException(503,'Η αποθήκευση δεν είναι διαθέσιμη.') from e

@router.post('/canonical/decision')
def canonical_decision(req: MetadataDecision):
    return write_canonical(canonical_library.review,req.recording_id,req.action,req.payload)

@router.post('/canonical/pattern-accept')
def canonical_pattern_accept(req: PatternDecision):
    def apply(db):
        rows=db.execute("SELECT recording_id,state FROM canonical_recordings WHERE EXISTS(SELECT 1 FROM json_each(evidence_json,'$.patterns') WHERE value=?)",(req.pattern,)).fetchall()
        reviewed=[r for r in rows if r['state']=='human' and db.execute("SELECT action FROM canonical_events WHERE recording_id=? ORDER BY id DESC LIMIT 1",(r['recording_id'],)).fetchone()[0]=='accept']
        if len(reviewed)<min(10,len(rows)) or not rows:raise ValueError('Ελέγξτε τουλάχιστον 10 παραδείγματα του μοτίβου πριν από τη μαζική εφαρμογή.')
        if any(r['state'] in {'rejected','kept_local'} for r in rows):raise ValueError('Υπάρχουν διαφωνίες στο μοτίβο. Απαιτείται ατομικός έλεγχος.')
        applied=0
        for r in rows:
            if r['state']=='review':canonical_library.review(db,r['recording_id'],'bulk_accept');applied+=1
        return {'applied':applied}
    return write_canonical(apply)

@router.post('/canonical/revoke-identity')
def canonical_revoke(req: RevokeDecision):
    require_local_pair(req.left_id, req.right_id)
    return write_canonical(canonical_library.revoke,req.left_id,req.right_id)

class NativeCollection(BaseModel):
    name: str
    source_id: str | None = None
    entity_ids: list[str] = []

class CollectionEntries(BaseModel):
    entity_ids: list[str]

@router.get('/collection-browser')
def collection_browser(q: str = '', service: str = '', offset: int = Query(0,ge=0), all_sources: bool=False, account: str='', grouped: bool=False):
    from ..services.library_collections import list_collections
    return read(list_collections,q,service,offset,100,all_sources,account,grouped)

@router.post('/collections/native')
def create_native_collection(req: NativeCollection):
    from ..services.library_collections import create
    return write_canonical(create,req.name,req.source_id,req.entity_ids)

@router.post('/collections/native/{collection_id}/entries')
def append_native_collection(collection_id: str, req: CollectionEntries):
    from ..services.library_collections import append
    return write_canonical(append,collection_id,req.entity_ids)

# Completeness and recovery are derived views plus explicit local decisions.
@router.get('/completeness')
def completeness(q: str='',scope: Literal['missing','all','playable','unresolved']='missing',provider: str='',account: str='',collection: str='',minimum: int=Query(0,ge=0),state: str='',origin: str='',saved: bool=False,offset: int=Query(0,ge=0),availability: str=''):
    from ..services.library_completeness import browse
    return read(browse,q,scope,provider,account,collection,minimum,state,origin,saved,offset,availability)

class RecoveryDecision(BaseModel):
    recording_id: str
    state: Literal['wanted','acquired','skipped','unavailable']

@router.post('/recovery')
def recovery(req: RecoveryDecision):
    from ..services.library_completeness import recover
    return write_canonical(recover,req.recording_id,req.state)

class AlgebraRequest(BaseModel):
    collection_ids: list[str]
    operation: Literal['union','intersection','difference']='union'
    exclude_playable: bool=False
    save_name: str | None=None

@router.post('/collections/algebra')
def collection_algebra(req: AlgebraRequest):
    from ..services.collection_intelligence import algebra
    # POST carries the ordered operand list; without save_name this is read-only.
    if req.save_name is not None:return write_canonical(algebra,req.collection_ids,req.operation,req.exclude_playable,req.save_name)
    try:return read(algebra,req.collection_ids,req.operation,req.exclude_playable)
    except ValueError as e:raise HTTPException(400,str(e)) from e

@router.get('/completeness-summary')
def completeness_summary():
    from ..services.library_completeness import index,metrics
    from ..services.collection_consolidation import active_rows
    return read(lambda db:{**metrics(index(db)), 'active_collections':len(active_rows(db)), 'source_observations':len(active_rows(db,all_sources=True))})

@router.get('/lineage')
def lineage(q: str='',category: str='',collection: str='',offset: int=Query(0,ge=0)):
    from ..services.collection_lineage import browse
    return read(browse,q,category,collection,offset)

@router.get('/lineage/detail')
def lineage_detail(id: str):
    from ..services.collection_lineage import detail
    return read(detail,id)

class LineageDecision(BaseModel):
    id: str
    action: Literal['accept','reject','reset']
    relation: Literal['exact_copy_of','migrated_from','likely_migrated_from','merged_from','descendant_of','possible_version_of','unrelated'] | None=None

@router.post('/lineage/decision')
def lineage_decision(req: LineageDecision):
    from ..services.collection_lineage import decide
    return write_canonical(decide,req.id,req.action,req.relation)

@router.get('/lineage/history')
def lineage_history(recording_id: str):
    from ..services.collection_lineage import history
    from ..services.provider_resolution import recording
    return read(lambda db:{**history(db,recording_id),'availability':recording(db,recording_id)['availability']})

class RecoveryFilters(BaseModel):
    q: str=''
    scope: Literal['all','missing','playable','unresolved']='all'
    provider: Literal['','soundcloud','spotify']=''
    account: str=''
    collection: str=''
    minimum: int=Field(0,ge=0)
    state: Literal['','wanted','acquired','skipped','unavailable']=''
    origin: Literal['','missing_file','never_local']=''
    saved: bool=False
    availability: str=''
    model_config={'extra':'forbid'}

class RecoveryQuery(BaseModel):
    preset: Literal['wanted','favourites','cross_provider','strong_interest','lost_files','discovery']='wanted'
    minimum_families: int=Field(3,ge=0)
    sort: Literal['families','raw_collections','wanted','soundcloud_plays','soundcloud_likes','artist']='families'
    offset: int=Field(0,ge=0)
    filters: RecoveryFilters=Field(default_factory=RecoveryFilters)
    save_name: str | None=None

@router.post('/recovery-priorities')
def recovery_priorities(req: RecoveryQuery):
    from ..services.recovery_prioritization import view
    filters=req.filters.model_dump()
    if req.save_name is not None:return write_canonical(view,req.preset,req.minimum_families,req.sort,req.offset,filters,req.save_name)
    try:return read(view,req.preset,req.minimum_families,req.sort,req.offset,filters)
    except (ValueError,TypeError) as e:raise HTTPException(400,str(e)) from e

# Presentation decisions are separate from historical lineage judgments.
from ..services import collection_consolidation as consolidation

@router.get('/collections/consolidation')
def consolidation_review():
    return read(lambda db: {'groups':consolidation.review_groups(db),'active':len(consolidation.active_rows(db)), 'observations':len(consolidation.active_rows(db,all_sources=True))})

@router.get('/collections/history')
def consolidation_history(id: str):
    return read(consolidation.history,id)

class ConsolidationPreview(BaseModel):
    ids: list[str]
    selected: str

@router.post('/collections/consolidation/preview')
def consolidation_preview(req: ConsolidationPreview):
    try:return read(consolidation.preview,req.ids,req.selected)
    except ValueError as e:raise HTTPException(409,str(e)) from e

class ConsolidationReview(BaseModel):
    ids: list[str]
    hashes: dict[str,str]
    action: Literal['representative','keep_separate','defer']
    selected: str | None=None
    acknowledged: list[str]=[]

@router.post('/collections/consolidation/decision')
def consolidation_decision(req: ConsolidationReview):
    return write_canonical(consolidation.review,req.ids,req.hashes,req.action,req.selected,req.acknowledged)

class ConsolidationUndo(BaseModel):
    decision_id: str | None=None
    batch_id: str | None=None

@router.post('/collections/consolidation/undo')
def consolidation_undo(req: ConsolidationUndo):
    return write_canonical(consolidation.undo,req.decision_id,req.batch_id)

class CollectionRestore(BaseModel):
    id: str

@router.post('/collections/consolidation/restore')
def consolidation_restore(req: CollectionRestore):
    return write_canonical(consolidation.restore,req.id)

# Explicit human recording identity decisions; independent of metadata review.
from ..services import manual_identity

class IdentityLinkDecision(BaseModel):
    left_id: str
    right_id: str
    token: str
    metadata_from: str = ''
    isrc_override_reason: str = ''

class AssetRetirement(BaseModel):
    entity_id: str
    survivor_id: str | None = None
    restore: bool = False

@router.get('/compare-identity')
def compare_identity(left_id: str, right_id: str):
    return read(manual_identity.comparison,left_id,right_id)

@router.post('/confirm-identity')
def confirm_identity(req: IdentityLinkDecision):
    require_local_pair(req.left_id, req.right_id)
    result = write_canonical(manual_identity.link,req.left_id,req.right_id,req.token,req.metadata_from,req.isrc_override_reason)
    _replay_identity_mirrors()
    return result


def _replay_identity_mirrors():
    # The authority transaction has committed before touching the catalog.
    # Most identity decisions have no SoundCloud mirror and need no catalog I/O.
    with identity_library.connect() as authority:
        pending = authority.execute("SELECT 1 FROM canonical_events i WHERE i.action='legacy_soundcloud_mirror_intent' AND NOT EXISTS(SELECT 1 FROM canonical_events done WHERE done.action IN ('legacy_soundcloud_mirror_applied','legacy_soundcloud_mirror_cancelled') AND json_extract(done.after_json,'$.intent_id')=i.id) LIMIT 1").fetchone()
    if not pending:
        return
    from sqlmodel import Session
    from ..db import get_engine
    from ..services.identity_sync import replay_mirror_intents
    try:
        with Session(get_engine(), expire_on_commit=False) as session:
            replay_mirror_intents(session)
    except (ValueError, sqlite3.Error) as exc:
        raise HTTPException(409, str(exc)) from exc

@router.post('/reject-identity')
def reject_identity(req: IdentityLinkDecision):
    require_local_pair(req.left_id, req.right_id)
    return write_canonical(manual_identity.reject,req.left_id,req.right_id,req.token)

@router.post('/undo-identity')
def undo_identity(req: RevokeDecision):
    require_local_pair(req.left_id, req.right_id)
    result = write_canonical(manual_identity.undo,req.left_id,req.right_id)
    _replay_identity_mirrors()
    return result

@router.post('/retire-asset')
def retire_asset(req: AssetRetirement):
    return write_canonical(manual_identity.retire,req.entity_id,req.survivor_id,req.restore)
