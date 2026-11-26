"""Catch-up run of the automatic source links (auto_v1): dry run, apply, undo. Never audio, never DJ-app files.

--dry-run BUNDLE --work DIR --out DIR   Copies a backup bundle into DIR and touches only that copy: plans, writes the
    pair file, the review file and the report into --out, applies on the copy, undoes the batch and requires the
    copy's recordings to be exactly what they were.
--apply --pairs FILE --reviewed FILE    With the app closed. Refuses without the pair file and without the review
    file carrying a ναι/όχι on every row. Makes and verifies a backup first, then writes in one transaction the
    pairs that are in the file and still pass; a pair that is not in the file is never written. A pair answered
    «όχι» is stored as a rejection, so no later run proposes it again.
--undo-batch ID                         With the app closed: a verified backup, then every decision of that batch
    is undone, newest first. Undone pairs are never linked automatically again.
--rollback BACKUP_DIR                   Restores catalog and identity together. Only before the app is reopened:
    it discards every later edit, play and set. Never restore identity.sqlite alone.
(no option)                             With the app closed: lists the batches in the library, changes nothing.
Run from backend/: uv run python ../reconciliation/auto_link.py ...
"""
from __future__ import annotations
import argparse
import csv
import io
import json
import random
import shutil
import sys
import time
from collections import Counter
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'backend'), str(Path(__file__).resolve().parent)]
import clean_working_library as cwl
from app.services import auto_link, source_keys
from app.services.dataset_access import DatasetBusyError

SEED = 20261126
FOLD_SAMPLE = 10
RULES = {'text_exact': 'Ίδιος καλλιτέχνης και τίτλος',
         'text_clean': 'Ίδιος καλλιτέχνης και τίτλος, χωρίς «Original Mix», BPM κ.λπ.',
         'artist_variant': 'Ίδιος τίτλος, ένας κοινός καλλιτέχνης',
         'artist_in_title': 'Καλλιτέχνης μέσα στον τίτλο',
         'same_words': 'Καλλιτέχνης και τίτλος με άλλη σειρά',
         'title_unknown_artist': 'Ίδιος τίτλος και διάρκεια, άγνωστος καλλιτέχνης',
         'title_supported': 'Ίδιος τίτλος, ο καλλιτέχνης στο όνομα αρχείου',
         'isrc_duration': 'Ίδιο ISRC και διάρκεια'}
KINDS = {'link': 'Σύνδεση με αρχείο', 'fold': 'Ένωση διπλότυπων'}
SERVICES = {'local': 'Τοπικό αρχείο', 'spotify': 'Spotify', 'soundcloud': 'SoundCloud'}
DECISION, LEFT, RIGHT = 'Απόφαση (ναι/όχι)', 'Κωδικός Α', 'Κωδικός Β'
SIDE = ('πηγή', 'καλλιτέχνης', 'τίτλος', 'διάρκεια', 'άλμπουμ', 'αρχείο ή χρήστης', 'ISRC')
COLUMNS = ['Είδος', 'Κανόνας', 'Διαφορά διάρκειας (δευτ.)', *(f'{side}: {name}' for side in 'ΑΒ' for name in SIDE), LEFT, RIGHT]
YES, NO = {'ναι', 'nai', 'yes', 'y', 'ν'}, {'όχι', 'οχι', 'oxi', 'no', 'n', 'ο'}


def clock(seconds): return '' if seconds is None else f'{int(seconds // 60)}:{seconds % 60:04.1f}'


def pair_row(decision, records):
    def side(record):
        return [SERVICES[record['service']], record['artist'], record['title'], clock(record['dur']), record['album'],
                record['file_name'] or record['uploader'], record['isrc']]
    return [KINDS[decision['kind']], RULES[decision['rule']], f"{decision['delta']:.1f}", *side(records[decision['left_id']]),
            *side(records[decision['right_id']]), decision['left_id'], decision['right_id']]


def write_csv(path, header, rows):
    with open(path, 'w', newline='', encoding='utf-8-sig') as f:  # the BOM lets spreadsheets read the Greek
        csv.writer(f).writerows([header, *rows])


def read_csv(path, label):
    if path is None or not Path(path).is_file():
        raise ValueError(f'Λείπει {label}. Η εφαρμογή γίνεται μόνο με το αρχείο ζευγών και το αρχείο ελέγχου της δοκιμής.')
    text = Path(path).read_text(encoding='utf-8-sig')
    separator = max(',;\t', key=text.split('\n', 1)[0].count)  # a spreadsheet may save the file with ; or tabs
    rows = list(csv.DictReader(io.StringIO(text, newline=''), delimiter=separator))
    if not rows or LEFT not in rows[0] or RIGHT not in rows[0]:
        raise ValueError(f'Το αρχείο {path} δεν έχει τις στήλες «{LEFT}» και «{RIGHT}».')
    return rows


def review_rows(planned, records):
    """What the owner reads before an apply: every title-only link, short titles first (the usual wrong match
    is a generic one- or two-word title), and a fixed-seed sample of each fold rule."""
    title_only = [d for d in planned['links'] if d['rule'] in source_keys.TITLE_ONLY_RULES]
    words = lambda sid: len(source_keys.norm(records[sid]['title']).split()) or 99
    rows = sorted(title_only, key=lambda d: (min(words(d['left_id']), words(d['right_id'])), d['left_id']))
    picker = random.Random(SEED)
    for rule in source_keys.FOLD_RULES:
        folds = [d for d in planned['folds'] if d['rule'] == rule]
        rows += picker.sample(folds, min(FOLD_SAMPLE, len(folds)))
    return rows


def reviewed_pairs(pairs_path, reviewed_path):
    """The pairs an apply may write: the pair file's rows, less the rows the owner answered «όχι» in the review
    file. Refuses unless every review row has an answer and every title-only link has been read."""
    pairs = read_csv(pairs_path, 'το αρχείο ζευγών (--pairs)')
    answers = {}
    for row in read_csv(reviewed_path, 'το αρχείο ελέγχου (--reviewed)'):
        answers[row[LEFT], row[RIGHT]] = (row.get(DECISION) or '').strip().casefold()
    blank = [pair for pair, answer in answers.items() if answer not in YES | NO]
    if blank:
        raise ValueError(f'{len(blank)} γραμμές του αρχείου ελέγχου δεν έχουν «ναι» ή «όχι» στη στήλη «{DECISION}».')
    title_only = {RULES[rule] for rule in source_keys.TITLE_ONLY_RULES}
    unread = [row for row in pairs if row.get('Κανόνας') in title_only and (row[LEFT], row[RIGHT]) not in answers]
    if unread:
        raise ValueError(f'{len(unread)} συνδέσεις μόνο από τον τίτλο δεν υπάρχουν στο αρχείο ελέγχου· πρέπει να διαβαστούν όλες.')
    struck = {pair for pair, answer in answers.items() if answer in NO}
    return {(row[LEFT], row[RIGHT]) for row in pairs} - struck, struck


def names(db):
    """{current local entity: (file name, shown artist, shown title)} as the pages show them."""
    from app.services.identity_library import current_local_predicate
    from app.services.metadata_display import recordings
    rows = db.execute("SELECT e.id,e.recording_id,json_extract(e.metadata_json,'$.file_name') FROM entities e WHERE "
                      + current_local_predicate()).fetchall()
    shown = recordings(db, sorted({r[1] for r in rows}))
    return {r[0]: (r[2], shown[r[1]]['artist'], shown[r[1]]['title']) for r in rows if r[1] in shown}


def recordings_state(db):
    """What an apply followed by an undo of its batch must leave exactly as it was."""
    return {'entities.recording_id': dict(db.execute('SELECT id,recording_id FROM entities').fetchall()),
            'entities.status': dict(db.execute('SELECT id,status FROM entities').fetchall()),
            'canonical_recordings': {r[0]: tuple(r)[1:] for r in db.execute(
                'SELECT recording_id,title,artist,version,release,state FROM canonical_recordings')}}


def guarded_state(db, limits):
    """Everything a batch must not change, plus the stored collection hashes that match their lists."""
    state = cwl.protected_state(db, limits)
    rows = []
    for row in db.execute('SELECT * FROM collection_consolidations ORDER BY rowid').fetchall():
        row = dict(row)
        for column, key in (('baseline_json', 'hashes'), ('result_json', 'representative_hashes')):
            row[column] = cwl.dump({k: v for k, v in json.loads(row[column]).items() if k != key})
        rows.append(tuple(row.values()))
    state['collection_consolidations'] = cwl.digest_rows(rows)
    state['collection_hashes_matching'] = sorted(cwl.matching_hashes(db))
    state['canonical_recordings.display'] = cwl.digest(
        db, 'SELECT recording_id,title,artist,version,release,state FROM canonical_recordings ORDER BY recording_id')
    return state


def store_rejections(db, struck):
    """Inside the caller's transaction: a pair the owner answered «όχι» is stored as a rejection, as a «Δεν είναι
    το ίδιο» answer in the app stores it, so no later run plans it again. Returns how many were new."""
    stored = 0
    for left, right in sorted(struck):
        if not db.execute('SELECT 1 FROM canonical_blocks WHERE (left_id=? AND right_id=?) OR (left_id=? AND right_id=?)',
                          (left, right, right, left)).fetchone():
            db.execute("INSERT INTO canonical_blocks VALUES (?,?,'human_rejection')", (left, right))
            stored += 1
    return stored


def write_batch(db, report, allowed=None):
    """Inside the caller's transaction: plan, write, and check that only the planned rows changed.
    Returns the plan and the records it was made on."""
    limits = cwl.row_limits(db)
    before, shown = guarded_state(db, limits), names(db)
    report['before'] = auto_link.headline(db)
    records, planned = auto_link.load(db), auto_link.plan(db, allowed)
    decided = planned['folds'] + planned['links']
    report['batch'] = auto_link.apply(db, planned)
    report['after'] = auto_link.headline(db)
    count = lambda rows, *keys: dict(sorted(Counter(' / '.join(r[k] for k in keys) for r in rows).items()))
    report['written'] = {'folds': len(planned['folds']), 'links': len(planned['links']),
                         'folds_per_rule': count(planned['folds'], 'rule'), 'links_per_rule': count(planned['links'], 'rule'),
                         'links_to_unlinked_tracks': report['after']['linked_local_tracks'] - report['before']['linked_local_tracks']}
    report['stopped_by_guard'] = count(planned['stopped'], 'kind', 'reason')
    report['review_set'] = count(planned['review'], 'reason')
    report['passing_but_not_in_file'] = [[d['left_id'], d['right_id'], d['rule']] for d in planned['outside']]
    moved = dict(before['entities.recording_id'])
    members = {}
    for sid, rid in moved.items(): members.setdefault(rid, []).append(sid)
    for d in decided:
        a, b = moved[d['left_id']], moved[d['right_id']]
        for sid in members.pop(b if d['target'] == a else a):
            moved[sid] = d['target']
            members[d['target']].append(sid)
    after = guarded_state(db, limits)
    for key in before:
        expected = moved if key == 'entities.recording_id' else before[key]
        cwl.check(report, f'unchanged_{key}' if key != 'entities.recording_id' else 'only_planned_recordings_moved',
                  expected == after[key], cwl.differing(expected, after[key]) if isinstance(expected, dict) else None)
    new = sorted((r[0], r[1], r[2], r[4], r[7]) for r in db.execute('SELECT * FROM identity_acceptances WHERE rowid>?', (limits['identity_acceptances'],)))
    cwl.check(report, 'new_ledger_rows_are_the_planned_pairs', new == sorted(
        (d['left_id'], d['right_id'], 'automatic_' + d['kind'], auto_link.METHOD + d['rule'], 'auto_high_confidence') for d in decided))
    events = Counter(r[0] for r in db.execute('SELECT action FROM canonical_events WHERE id>?', (limits['canonical_events'],)))
    mirrors = sum(d['kind'] == 'link' and d['right_id'].startswith('soundcloud:tracks:') for d in decided)
    cwl.check(report, 'new_events_are_the_planned_pairs', events == Counter(
        {k: v for k, v in (('automatic_identity_link', len(decided)), ('legacy_soundcloud_mirror_intent', mirrors),
                           (auto_link.REVIEW_EVENT, 1)) if v}), dict(events))
    report['soundcloud_rows_for_the_catalog'] = mirrors
    now = names(db)
    report['names_changed'] = [{'local_id': sid, 'file_name': shown[sid][0], 'before': list(shown[sid][1:]), 'after': list(now[sid][1:])}
                               for sid in sorted(shown) if sid in now and shown[sid][1:] != now[sid][1:]]
    # Recordings an earlier automatic link made (the November clean-up): from now on they keep their shown name
    # when the file is retagged, like hand-linked ones (identity_sync._canonical_row).
    from app.services.identity_library import current_local_predicate
    report['names_now_frozen'] = [{'local_id': r[0], 'file_name': r[1]} for r in db.execute(
        "SELECT e.id,json_extract(e.metadata_json,'$.file_name') FROM entities e JOIN canonical_recordings c ON c.recording_id=e.recording_id "
        f"WHERE {current_local_predicate()} AND c.state NOT IN (?,?,?) AND EXISTS(SELECT 1 FROM canonical_events x WHERE x.recording_id=e.recording_id "
        "AND x.action='automatic_identity_link' AND x.id<=?) AND NOT EXISTS(SELECT 1 FROM canonical_events x WHERE x.recording_id=e.recording_id "
        "AND x.action='human_identity_link') ORDER BY e.id", (*auto_link.PROTECTED, limits['canonical_events']))]
    return planned, records


def replay_mirrors(catalog, identity):
    """Bring the catalog's SoundCloud match rows in line with the identity decisions just committed."""
    from sqlmodel import Session, create_engine
    from app.services.identity_sync import replay_mirror_intents
    engine = create_engine(f'sqlite:///{catalog}')
    try:
        with Session(engine, expire_on_commit=False) as session:
            return replay_mirror_intents(session, identity)
    finally:
        engine.dispose()


def soundcloud_matches(catalog):
    with closing(cwl.connect(catalog)) as db:
        return sorted(tuple(r) for r in db.execute('SELECT track_id,soundcloud_track_id FROM track_soundcloud_matches'))


def soundcloud_candidates(catalog):
    with closing(cwl.connect(catalog)) as db:
        return {(r[0], r[1]): r[2] for r in db.execute('SELECT track_id,soundcloud_track_id,status FROM soundcloud_match_candidates')}


def dry_run(args):
    from app.services.backup import verify_backup
    from app.services.identity_matching import refresh_entity_statuses, refresh_near_ties
    if not args.work or not args.out:
        raise ValueError('Η δοκιμή χρειάζεται --work (φάκελο για το αντίγραφο) και --out (φάκελο για τα αρχεία της).')
    work, out = args.work.resolve(), args.out.resolve()
    if (work.exists() and any(work.iterdir())) or any((folder / 'active.json').exists() for folder in (work, *work.parents)):
        raise ValueError(f'Ο φάκελος {work} πρέπει να είναι άδειος και έξω από τη βιβλιοθήκη· η δοκιμή γράφει μόνο σε δικό της αντίγραφο.')
    verify_backup(args.dry_run)
    work.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    catalog, identity = (Path(shutil.copy2(args.dry_run / f'{name}.sqlite', work / f'{name}.sqlite')) for name in ('catalog', 'identity'))
    for path in (catalog, identity): path.chmod(0o644)
    report = {'ok': False, 'mode': 'dry-run', 'bundle': str(args.dry_run), 'copy': str(work), 'assertions': {}}
    with closing(cwl.connect(identity)) as db:
        db.execute('BEGIN IMMEDIATE')
        # Bring badges up to date first, so the comparison below sees only what the batch did.
        report['drift'] = {'near_ties': refresh_near_ties(db), 'statuses': refresh_entity_statuses(db)}
        db.execute('COMMIT')
        original, matches, candidates = recordings_state(db), soundcloud_matches(catalog), soundcloud_candidates(catalog)
        started = time.perf_counter()
        db.execute('BEGIN IMMEDIATE')
        try:
            planned, records = write_batch(db, report)
        except cwl.CheckFailed:
            db.execute('ROLLBACK')
            return report
        db.execute('COMMIT')
        report['seconds'] = {'plan_apply_and_checks': round(time.perf_counter() - started, 1)}
        review = review_rows(planned, records)
        write_csv(out / 'pairs.csv', COLUMNS, [pair_row(d, records) for d in planned['folds'] + planned['links']])
        write_csv(out / 'review.csv', [DECISION, *COLUMNS], [['', *pair_row(d, records)] for d in review])
        report['files'] = {'pairs': str(out / 'pairs.csv'), 'review': str(out / 'review.csv'), 'review_rows': len(review)}
        report['mirror_after_apply'] = replay_mirrors(catalog, identity)
        again = auto_link.plan(db)
        report['second_run_would_add'] = {'folds': len(again['folds']), 'links': len(again['links'])}
        joined = recordings_state(db)['entities.recording_id']
        started = time.perf_counter()
        db.execute('BEGIN IMMEDIATE')
        report['undo'] = auto_link.undo_batch(db, report['batch'])
        db.execute('COMMIT')
        report['seconds']['undo_batch'] = round(time.perf_counter() - started, 1)
        report['mirror_after_undo'] = replay_mirrors(catalog, identity)
        restored = recordings_state(db)
        badges = {sid for sid, status in original.pop('entities.status').items() if restored['entities.status'].get(sid) != status}
        report['round_trip'] = {key: {'equal': original[key] == restored[key], 'differing': cwl.differing(original[key], restored[key])}
                                for key in original}
        report['round_trip']['catalog_soundcloud_matches'] = {'equal': matches == soundcloud_matches(catalog)}
        # An undo re-scores the suggestions of the records it touched and no longer offers an undone pair, so
        # the badges (entities.status) are recomputed, not restored; they are counted, not required to match.
        in_batch = {sid for d in planned['folds'] + planned['links'] for sid in (d['left_id'], d['right_id'])}
        report['badges_recomputed'] = {'records': len(badges), 'of_the_batch': len(badges & in_batch), 'others': len(badges - in_batch)}
        # The catalog's SoundCloud suggestions are not restored either: the apply's mirror decides every suggestion of
        # the track (identity_sync._replay_mirror_intent) and the undo's mirror rejects only the undone pair, so a
        # suggestion that was pending stays rejected. Counted, not required to match (an owner decision, see report.md).
        now = soundcloud_candidates(catalog)
        report['catalog_candidate_statuses_changed'] = dict(sorted(Counter(
            f'{status} -> {now.get(pair, "missing")}' for pair, status in candidates.items() if now.get(pair) != status).items()))
        # After the undo a new run must not join again what the batch had joined. It may still decide a pair the
        # batch never joined (one that a now-undone fold had been standing in the way of).
        later = auto_link.plan(db)
        later = later['folds'] + later['links']
        report['after_undo_would_link_again'] = sum(joined[d['left_id']] == joined[d['right_id']] for d in later)
        report['after_undo_new_pairs'] = [[d['kind'], d['rule'], d['left_id'], d['right_id']] for d in later]
    report['ok'] = (all(v == 'ok' for v in report['assertions'].values()) and all(v['equal'] for v in report['round_trip'].values())
                    and not any(report['second_run_would_add'].values()) and not report['after_undo_would_link_again'])
    (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return report


def backup(ds, root, label):
    """A verified backup of both databases, or an exception before anything is written."""
    from app.services.active_dataset import resolve_active_dataset
    from app.services.backup import create_backup, verify_backup
    need, free = 3 * sum(cwl.file_sizes(ds.catalog, ds.identity).values()), shutil.disk_usage(root).free
    if free < need:
        raise ValueError(f'Ανεπαρκής ελεύθερος χώρος για το αντίγραφο ασφαλείας: {free} bytes, απαιτούνται {need}.')
    directory = root / 'backups' / f'{label}-{cwl.stamp()}'
    if directory.exists(): raise FileExistsError(f'Το αντίγραφο {directory} υπάρχει ήδη.')
    bundle = create_backup(ds.catalog, directory, identity_path=ds.identity, keep=None, reuse=False)
    verify_backup(bundle)
    generation = resolve_active_dataset(root).generation_dir
    for name in ('exchange-state.json', 'manifest.json'):
        if (generation / name).is_file(): shutil.copy2(generation / name, directory / name)
    return {'directory': str(directory), 'bundle': str(bundle),
            'rollback_command': f'cd backend && uv run python ../reconciliation/auto_link.py --rollback "{directory}"'}


def live(ds, args, reviewed):
    if ds.dataset_root is None or ds.identity is None:
        raise ValueError('Απαιτείται ενεργή βιβλιοθήκη (CRATEMIND_DATASET_ROOT) με βάση identity.')
    report = {'ok': False, 'mode': 'apply' if args.apply else 'undo-batch', 'dataset_root': str(ds.dataset_root), 'assertions': {}}
    if args.apply:
        allowed, struck = reviewed
        report['file'] = {'pairs_allowed': len(allowed), 'struck_in_review': len(struck)}
    report['backup'] = backup(ds, ds.dataset_root, 'auto-link' if args.apply else 'auto-link-undo')
    with closing(cwl.connect(ds.identity)) as db:
        db.execute('BEGIN IMMEDIATE')
        try:
            if args.apply:
                report['file']['rejections_stored'] = store_rejections(db, struck)
                planned, _ = write_batch(db, report, allowed)
                written = {(d['left_id'], d['right_id']) for d in planned['folds'] + planned['links']}
                report['in_file_but_no_longer_passing'] = sorted(map(list, allowed - written))
            else:
                report['undo'] = auto_link.undo_batch(db, args.undo_batch)
        except cwl.CheckFailed:
            db.execute('ROLLBACK')
            return cwl.finish(report)
        except BaseException:
            db.execute('ROLLBACK')
            raise
        db.execute('COMMIT')
    report['mirror'] = replay_mirrors(ds.catalog, ds.identity)
    report['ok'] = True
    return cwl.finish(report)


def status(ds):
    from app.services import identity_library
    if ds.identity is None: raise ValueError('Η ενεργή βιβλιοθήκη δεν έχει βάση identity.')
    with identity_library.connect(ds.identity) as db:
        return {'ok': True, 'mode': 'status', 'batches': auto_link.decisions(db, limit=0)['batches']}


def summary(report):
    if report['mode'] == 'rollback': return cwl.summary(report)
    if report['mode'] == 'status':
        return [f"Παρτίδα {b['id']} ({b['accepted_at'][:10]}): {b['link']} συνδέσεις με αρχείο, {b['fold']} ενώσεις διπλότυπων"
                for b in report['batches']] or ['Δεν υπάρχουν αυτόματες συνδέσεις στη βιβλιοθήκη.']
    lines = ['Λειτουργία: ' + {'dry-run': 'δοκιμή σε αντίγραφο (η βιβλιοθήκη δεν άλλαξε)', 'apply': 'εφαρμογή',
                               'undo-batch': 'αναίρεση παρτίδας'}[report['mode']]]
    if 'written' in report:
        before, after, written = report['before'], report['after'], report['written']
        share = lambda v: f"{v['linked_local_tracks']} από {v['local_tracks']} ({100 * v['linked_local_tracks'] / max(v['local_tracks'], 1):.1f}%)"
        lines += [f"Παρτίδα {report['batch']}: {written['links']} συνδέσεις με αρχείο, {written['folds']} ενώσεις διπλότυπων.",
                  f"Τοπικά κομμάτια συνδεδεμένα με πηγή: {share(before)} -> {share(after)}",
                  f"«Μόνο σε πηγές»: {before['remote_only']} -> {after['remote_only']}",
                  f"Για έλεγχο με το χέρι: {sum(report['review_set'].values())} κομμάτια· αλλάζουν εμφανιζόμενο όνομα: {len(report['names_changed'])}"]
    if 'undo' in report: lines.append(f"Αναιρέθηκαν {report['undo']['undone']} αποφάσεις της παρτίδας {report['undo']['batch']}.")
    if 'round_trip' in report:
        lines.append('Εφαρμογή και αναίρεση στο αντίγραφο: ' + (
            f"ηχογραφήσεις, ονόματα και γραμμές SoundCloud όπως πριν· {report['badges_recomputed']['records']} σήματα κατάστασης υπολογίστηκαν ξανά"
            if all(v['equal'] for v in report['round_trip'].values())
            else 'ΔΙΑΦΟΡΕΣ: ' + ', '.join(k for k, v in report['round_trip'].items() if not v['equal'])))
    for key, label in (('in_file_but_no_longer_passing', 'Ζεύγη του αρχείου που δεν περνούν πια (δεν γράφτηκαν)'),
                       ('passing_but_not_in_file', 'Ζεύγη που περνούν αλλά δεν είναι στο αρχείο (δεν γράφτηκαν)')):
        if report.get(key): lines.append(f'{label}: {len(report[key])}')
    failed = [k for k, v in report['assertions'].items() if v != 'ok']
    lines.append('Έλεγχοι: ' + ('όλοι επιτυχείς' if not failed else 'αποτυχία ' + ', '.join(failed)))
    if 'files' in report: lines += [f"Αρχείο ζευγών: {report['files']['pairs']}", f"Αρχείο ελέγχου ({report['files']['review_rows']} γραμμές): {report['files']['review']}"]
    if 'backup' in report: lines += [f"Αντίγραφο ασφαλείας: {report['backup']['directory']}", f"Επαναφορά: {report['backup']['rollback_command']}"]
    return lines


def main(argv=None):
    parser = argparse.ArgumentParser(description='Αυτόματες συνδέσεις με πηγές: δοκιμή σε αντίγραφο, εφαρμογή, αναίρεση.')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', type=Path, metavar='BUNDLE', help='δοκιμή σε αντίγραφο ενός φακέλου αντιγράφου ασφαλείας (cratemind-…)')
    mode.add_argument('--apply', action='store_true', help='εφαρμογή στη βιβλιοθήκη, με την εφαρμογή κλειστή')
    mode.add_argument('--undo-batch', metavar='ID', help='αναίρεση όλων των αποφάσεων μιας παρτίδας')
    mode.add_argument('--rollback', type=Path, metavar='BACKUP_DIR', help='επαναφορά και των δύο βάσεων από αντίγραφο της εφαρμογής')
    parser.add_argument('--work', type=Path, help='άδειος φάκελος για το αντίγραφο της δοκιμής')
    parser.add_argument('--out', type=Path, help='φάκελος για την αναφορά και τα αρχεία της δοκιμής')
    parser.add_argument('--pairs', type=Path, help='το αρχείο ζευγών της δοκιμής (pairs.csv)')
    parser.add_argument('--reviewed', type=Path, help='το αρχείο ελέγχου με «ναι» ή «όχι» σε κάθε γραμμή (review.csv)')
    parser.add_argument('--json', action='store_true', help='πλήρης αναφορά JSON')
    args = parser.parse_args(argv)
    try:
        if args.dry_run:
            report = dry_run(args)
        else:
            reviewed = reviewed_pairs(args.pairs, args.reviewed) if args.apply else None  # refuses before anything is opened
            with cwl.writer_context('auto-link') as ds:
                report = (cwl.rollback(ds, args.rollback) if args.rollback else live(ds, args, reviewed) if args.apply or args.undo_batch
                          else status(ds))
    except DatasetBusyError:
        print('Δεν έγινε καμία αλλαγή: η βιβλιοθήκη είναι ανοιχτή στο CrateMind. Κλείσε την εφαρμογή και δοκίμασε ξανά.', file=sys.stderr)
        raise  # like every writer script: fail closed, by name, while the app holds the library
    except ValueError as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False) if args.json else f'Δεν έγινε καμία αλλαγή: {error}')
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2, default=list) if args.json else '\n'.join(summary(report)))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
