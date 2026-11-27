"""«Καθαρά ονόματα»: the one-time import of the owner's research answers into the library. Never audio.

The answers were given on sheets before the app could hold them: an answers file (owner-answers.json's shape), a
seed sheet of spellings (decisions-seed.csv's shape) and the owner's word for a folder of loose tracks. This script
writes them as `name_decisions` rows through names_store.import_answers, and copies the /canonical edits that are
still their recording's state into track decisions. A second run adds nothing, and an answer the owner has undone
in the app is never written again. A friend's library has no such files and never needs this script.

--dry-run BUNDLE --work DIR --answers FILE [--seed FILE] [--loose WORD ...]
    Copies a backup bundle into the empty folder DIR and writes only to that copy. Reports what the import would
    add, then imports twice and requires the second import to add nothing.
--apply --answers FILE [--seed FILE] [--loose WORD ...]
    With the app closed. Makes and verifies a backup of both databases first, then writes the rows in one commit.
(no option)
    With the app closed: counts the name decisions in the library, changes nothing.
Run from backend/: uv run python ../reconciliation/names_import.py ...
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'backend'), str(Path(__file__).resolve().parent)]
from app.services.dataset_access import DatasetBusyError
from app.services.writer_context import writer_context


def read_inputs(args):
    if not args.answers:
        raise ValueError('Χρειάζεται --answers (το αρχείο με τις απαντήσεις).')
    answers = json.loads(args.answers.read_text(encoding='utf-8'))
    if not isinstance(answers, dict) or not isinstance(answers.get('answers'), list):
        raise ValueError(f'Το {args.answers} δεν έχει τη μορφή των απαντήσεων (λίστα «answers»).')
    seeds = []
    if args.seed:
        with args.seed.open(encoding='utf-8', newline='') as handle:
            seeds = list(csv.DictReader(handle))
    return answers, seeds, tuple(args.loose or ())


def counts(session):
    from sqlalchemy import text
    from sqlalchemy.exc import OperationalError
    try:
        rows = session.connection().execute(text(
            'SELECT kind, source, count(*), sum(revoked_at IS NOT NULL) FROM name_decisions GROUP BY kind, source ORDER BY kind, source'))
    except OperationalError as error:  # a library the updated app has not opened yet
        raise ValueError('Η βιβλιοθήκη δεν έχει ακόμη τον πίνακα των απαντήσεων: άνοιξε πρώτα μία φορά τη νέα έκδοση του CrateMind.') from error
    return [{'kind': r[0], 'source': r[1], 'rows': r[2], 'revoked': r[3] or 0} for r in rows]


def write(session, inputs, report, dry_run=False):
    from app.services import names_store
    answers, seeds, loose = inputs
    report['import'] = names_store.import_answers(session, answers, seeds, loose, dry_run=dry_run)
    if not dry_run:
        report['canonical_edits_copied'] = names_store.copy_canonical_edits(session)
    return report['import']


def dry_run(args):
    from sqlmodel import Session
    from app.services.backup import verify_backup
    inputs = read_inputs(args)
    if not args.work:
        raise ValueError('Η δοκιμή χρειάζεται --work (άδειο φάκελο για το αντίγραφο).')
    work = args.work.resolve()
    if (work.exists() and any(work.iterdir())) or any((folder / 'active.json').exists() for folder in (work, *work.parents)):
        raise ValueError(f'Ο φάκελος {work} πρέπει να είναι άδειος και έξω από τη βιβλιοθήκη· η δοκιμή γράφει μόνο σε δικό της αντίγραφο.')
    verify_backup(args.dry_run)
    work.mkdir(parents=True, exist_ok=True)
    for name in ('catalog', 'identity'):
        if (args.dry_run / f'{name}.sqlite').is_file():
            shutil.copy2(args.dry_run / f'{name}.sqlite', work / f'{name}.sqlite').chmod(0o644)
    # Point this process at the copy and nothing else, then give the copy the tables an older bundle lacks.
    os.environ.update({'CRATEMIND_DATASET_ROOT': '', 'CRATEMIND_DB_PATH': str(work / 'catalog.sqlite'),
                       'CRATEMIND_IDENTITY_DB_PATH': str(work / 'identity.sqlite')})
    import app.config as config
    import app.db as database
    config.get_settings.cache_clear()
    database._engine, database._settings = None, config.get_settings()
    if database._settings.db_file.resolve() != (work / 'catalog.sqlite').resolve():
        raise ValueError('Η δοκιμή δεν μπόρεσε να δείξει μόνο στο αντίγραφο.')
    database.init_db()
    report = {'ok': False, 'mode': 'dry-run', 'bundle': str(args.dry_run), 'copy': str(work)}
    with Session(database.get_engine()) as session:
        report['would_add'] = write(session, inputs, {}, dry_run=True)
        first = write(session, inputs, report)
        second = write(session, inputs, {})
        report['second_import_adds'] = second['added']
        report['decisions'] = counts(session)
    database.get_engine().dispose()
    report['ok'] = report['would_add']['added'] == first['added'] and second['added'] == 0 and not first['rejected']
    return report


def live(ds, args):
    from sqlalchemy import create_engine
    from sqlmodel import Session
    from auto_link import backup
    inputs = read_inputs(args)
    if ds.dataset_root is None:
        raise ValueError('Απαιτείται ενεργή βιβλιοθήκη (CRATEMIND_DATASET_ROOT).')
    report = {'ok': False, 'mode': 'apply', 'dataset_root': str(ds.dataset_root)}
    engine = create_engine(f'sqlite:///{ds.catalog}')
    try:
        with Session(engine) as session:
            counts(session)  # refuses, before the backup, a library without the table
        report['backup'] = backup(ds, ds.dataset_root, 'names-import')
        with Session(engine) as session:
            check = write(session, inputs, {}, dry_run=True)
            if check['rejected']:
                report['import'] = check
                return report  # nothing is written while one row is refused
            write(session, inputs, report)
            report['decisions'] = counts(session)
    finally:
        engine.dispose()
    report['ok'] = True
    return report


def status(ds):
    from sqlalchemy import create_engine
    from sqlmodel import Session
    engine = create_engine(f'sqlite:///file:{ds.catalog}?mode=ro&uri=true')
    try:
        with Session(engine) as session:
            return {'ok': True, 'mode': 'status', 'decisions': counts(session)}
    finally:
        engine.dispose()


def summary(report):
    lines = ['Λειτουργία: ' + {'dry-run': 'δοκιμή σε αντίγραφο (η βιβλιοθήκη δεν άλλαξε)', 'apply': 'εφαρμογή',
                               'status': 'μόνο ανάγνωση'}[report['mode']]]
    if 'backup' in report:
        lines.append(f"Αντίγραφο ασφαλείας: {report['backup']['directory']}")
    done = report.get('import')
    if done:
        lines.append(f"Απαντήσεις που γράφτηκαν: {done['added']} · υπήρχαν ήδη: {done['skipped']}")
        lines += [f'Δεν γράφτηκε: {reason}' for reason in done['rejected']]
    if 'canonical_edits_copied' in report:
        lines.append(f"Διορθώσεις από τη σελίδα ταυτότητας: {report['canonical_edits_copied']}")
    if 'second_import_adds' in report:
        lines.append(f"Δεύτερη εισαγωγή στο αντίγραφο: {report['second_import_adds']} νέες γραμμές")
    for row in report.get('decisions', []):
        lines.append(f"  {row['kind']} ({row['source']}): {row['rows']} γραμμές, {row['revoked']} αναιρεμένες")
    lines.append('Ολοκληρώθηκε.' if report['ok'] else 'Δεν ολοκληρώθηκε: δες τις γραμμές παραπάνω.')
    return lines


def main(argv=None):
    parser = argparse.ArgumentParser(description='Εισαγωγή των απαντήσεων για τα καθαρά ονόματα: δοκιμή σε αντίγραφο, εφαρμογή.')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', type=Path, metavar='BUNDLE', help='δοκιμή σε αντίγραφο ενός φακέλου αντιγράφου ασφαλείας (cratemind-…)')
    mode.add_argument('--apply', action='store_true', help='εφαρμογή στη βιβλιοθήκη, με την εφαρμογή κλειστή')
    parser.add_argument('--work', type=Path, help='άδειος φάκελος για το αντίγραφο της δοκιμής')
    parser.add_argument('--answers', type=Path, help='το αρχείο απαντήσεων (owner-answers.json)')
    parser.add_argument('--seed', type=Path, help='το φύλλο με τις γραφές ονομάτων (decisions-seed.csv)')
    parser.add_argument('--loose', action='append', metavar='WORD', help='λέξη που ονομάζει φάκελο με χύμα κομμάτια')
    parser.add_argument('--json', action='store_true', help='πλήρης αναφορά JSON')
    args = parser.parse_args(argv)
    try:
        if args.dry_run:
            report = dry_run(args)
        else:
            with writer_context('names-import') as ds:
                report = live(ds, args) if args.apply else status(ds)
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
