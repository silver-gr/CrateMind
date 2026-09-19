from pathlib import Path
import json
from playwright.sync_api import sync_playwright
out=Path(__file__).parent/'identity/lineage'
with sync_playwright() as p:
    browser=p.chromium.launch(channel='chrome',headless=True)
    page=browser.new_page(viewport={'width':1512,'height':1050});errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('http://127.0.0.1:5173/recovery')
    page.get_by_role('combobox',name='Σύνολο ανάκτησης').wait_for()
    page.get_by_text('0 ηχογραφήσεις',exact=True).wait_for(timeout=45000)
    assert 'Η ουρά μου' in page.get_by_role('combobox',name='Σύνολο ανάκτησης').inner_text()
    page.get_by_role('combobox',name='Σύνολο ανάκτησης').click()
    with page.expect_response(lambda r:'/recovery-priorities' in r.url and r.request.post_data_json.get('preset')=='favourites',timeout=45000) as response:
        page.get_by_role('option',name='Πρόταση: αγαπημένα χωρίς τοπικό',exact=True).click()
    result=response.value.json();assert result['intent']=='recommendation_only' and result['total']>0
    page.get_by_text(f"{result['total']} ηχογραφήσεις",exact=True).wait_for()
    page.wait_for_timeout(350)
    page.screenshot(path=str(out/'recovery-priorities.png'))
    links=page.request.get('http://127.0.0.1:8000/api/identity/lineage?category=merged_from').json()['items']
    merged=next(r for r in links if r['status']=='accepted')
    page.goto('http://127.0.0.1:5173/provenance?id='+merged['id'])
    page.get_by_role('button',name='Αποδοχή σχέσης',exact=True).wait_for(timeout=45000)
    page.get_by_text('Στοιχεία και χρονικές ομάδες',exact=True).click()
    assert 'exact_concatenation' in page.inner_text('body')
    page.screenshot(path=str(out/'prog-merge.png'))
    page.goto('http://127.0.0.1:5173/collections?id='+merged['destination']['id'])
    page.get_by_text('Προέλευση συλλογής',exact=False).first.wait_for(timeout=45000)
    page.get_by_text('Προέλευση συλλογής',exact=False).first.click()
    page.wait_for_timeout(1200)
    assert 'οικογένειες' in page.inner_text('body')
    page.screenshot(path=str(out/'collection-lineage.png'))
    assert not errors,errors
    (out/'browser.json').write_text(json.dumps({'page_errors':errors,'default_wanted_only':True,'recommendation_not_intent':True,'favourites':result['total'],'merge_evidence':True,'collection_family_counts':True,'production_database_writes':0},indent=2))
    browser.close()
