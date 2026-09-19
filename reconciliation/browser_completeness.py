from pathlib import Path
import json
from playwright.sync_api import sync_playwright
out=Path(__file__).parent/'identity'/'completeness'
with sync_playwright() as p:
    browser=p.chromium.launch(channel='chrome',headless=True)
    page=browser.new_page(viewport={'width':1512,'height':1050});errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('http://127.0.0.1:5173/recovery')
    page.get_by_role('heading',name='Πληρότητα & ανάκτηση').wait_for()
    page.wait_for_function("document.body.innerText.includes('19,824') || document.body.innerText.includes('19.824')",timeout=45000)
    page.get_by_role('textbox',name='Αναζήτηση ηχογραφήσεων').fill('soundcloud_like collections:5+')
    page.wait_for_timeout(4000)
    assert page.locator('li').count()>0
    page.screenshot(path=str(out/'recovery.png'),full_page=False)
    summer='cratemind:collection:0342e5c343d44020b5973a996a95a0c2'
    page.goto('http://127.0.0.1:5173/collections?id='+summer)
    page.get_by_role('heading',name='Summer 2023 — CrateMind',exact=True).wait_for(timeout=45000)
    page.get_by_role('combobox',name='Διαθεσιμότητα θέσεων').click()
    page.get_by_role('option',name='Μόνο στην πηγή (4)',exact=True).click()
    assert page.locator('ol > li').count()==4
    page.wait_for_timeout(300)
    page.screenshot(path=str(out/'summer-missing.png'),full_page=False)
    page.get_by_text('Σύγκριση & πράξεις συλλογών',exact=True).click()
    page.get_by_label('Αφαίρεση όσων παίζουν τοπικά').check()
    page.get_by_role('button',name='Προεπισκόπηση',exact=True).click()
    page.get_by_role('textbox',name='Όνομα παράγωγης συλλογής').wait_for(timeout=45000)
    assert page.get_by_text('4 ηχογραφήσεις',exact=True).count()==1
    page.screenshot(path=str(out/'algebra-preview.png'),full_page=False)
    # Preview only on the real catalog; save/recovery writes are tested on isolated fixtures.
    assert not errors,errors
    (out/'browser.json').write_text(json.dumps({'page_errors':errors,'recovery_search':True,'summer_remote_positions':4,'algebra_preview':4,'production_writes':0},indent=2))
    browser.close()
