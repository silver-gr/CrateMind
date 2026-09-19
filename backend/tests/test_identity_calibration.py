"""Validate holdout isolation, recording-equivalent evaluation and report safety."""
import importlib.util
from pathlib import Path

from app.services.identity_matching import normalized_item

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('calibration_test', ROOT/'reconciliation/calibrate_identity.py')
calibration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(calibration)


def item(sid, service='spotify', title='Moon Garden'):
    return normalized_item({'id':sid,'service':service,'title':title,'artist':'Alpha','duration_ms':300000,'kind':'track','isrc':'GBABC2612345'})


def test_truth_is_not_injected_into_retrieval(monkeypatch):
    items={x['id']:x for x in (item('a','local'),item('truth'),item('wrong',title='Other Piece'))}
    monkeypatch.setattr(calibration.CandidateIndex,'retrieve',lambda self,left:['wrong'])
    result=calibration.evaluate(items,{'a':{'truth'}},'spotify')[0]
    assert result['rank'] is None and not result['retrieved']
    assert result['class']=='not retrieved'
    assert result['truth_diagnostics'][0]['score']>=94
    assert all(r['right_id']!='truth' for r in result['top'])


def test_equivalent_recordings_and_isrc_masking():
    items={x['id']:x for x in (item('a','local'),item('release1'),item('release2'))}
    result=calibration.evaluate(items,{'a':{'release1','release2'}},'spotify',mask_isrc=True)[0]
    assert result['rank']==1
    assert not any(r['evidence']['isrc_equal'] for r in result['top'])
    assert not any(r['class']=='ACCEPTED' for r in result['top'])
    assert calibration.metrics([result])['recall@1']==1


def test_review_metadata_cannot_inject_html_or_script():
    evil=item('x',title='</script><script>alert(1)</script>')
    row={'left':calibration.describe(evil),'right':calibration.describe(item('y')),'stratum':'test','score':90,'evidence':{}}
    rendered=calibration.render_report({'benchmarks':{}},[row])
    assert '<script>alert(1)</script>' not in rendered
    assert '\\u003c/script\\u003e' in rendered
    assert 'data-verdict="0"' in rendered
