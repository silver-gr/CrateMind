import json
import pytest
from tests.test_canonical import fixture_db,entity,put,edge
from app.services import canonical_library as c, manual_identity as m, identity_library


def prepared():
    db=fixture_db();a=entity('local:1','local');b=entity('spotify:track:b','spotify')
    put(db,a);put(db,b);edge(db,a,b)
    db.execute("UPDATE candidates SET class='AMBIGUOUS'")
    c.promote(db);db.commit()
    return db,a['id'],b['id']


def test_manual_ambiguous_link_idempotency_and_undo_preserve_later_metadata():
    db,a,b=prepared()
    c.review(db,a,'accept');db.commit()
    assert db.execute('SELECT count(*) FROM identity_acceptances').fetchone()[0]==0
    preview=m.comparison(db,a,b)
    assert not preview['hard_blocks']
    result=m.link(db,a,b,preview['token'],b);db.commit()
    assert result['recording_id']==b
    assert m.link(db,a,b,preview['token'],b)['already_accepted'];db.commit()
    c.review(db,b,'edit',{'title':'Later edit','credits':[{'name':'Artist A','role':'primary'}]});db.commit()
    assert not m.undo(db,a,b)['still_connected'];db.commit()
    assert c.detail(db,b)['title']=='Later edit'
    assert db.execute('SELECT count(DISTINCT recording_id) FROM entities').fetchone()[0]==2


def test_rejection_and_stale_guards():
    db,a,b=prepared();preview=m.comparison(db,a,b)
    c.review(db,a,'accept');db.commit()
    with pytest.raises(ValueError,match='changed'):m.link(db,a,b,preview['token'],b)
    db.rollback();preview=m.comparison(db,a,b)
    m.reject(db,a,b,preview['token']);db.commit()
    preview=m.comparison(db,a,b)
    assert preview['hard_blocks']
    with pytest.raises(ValueError,match='human_rejection'):m.link(db,a,b,preview['token'],b)
    db.rollback()


def test_whole_component_guards_and_no_autoretirement():
    db,a,b=prepared()
    x=entity('soundcloud:tracks:x','soundcloud',title='Song (Live)');put(db,x)
    db.execute('INSERT INTO canonical_base_entities VALUES (?,?,?)',(x['id'],x['id'],'PROVISIONAL'))
    db.execute('UPDATE entities SET recording_id=? WHERE id=?',(b,x['id']));db.commit()
    assert m.comparison(db,a,b)['hard_blocks']
    with pytest.raises(ValueError,match='dedup'):m.retire(db,a,b)
    db.rollback()
    assert json.loads(db.execute('SELECT metadata_json FROM entities WHERE id=?',(a,)).fetchone()[0])=={}
