import json
from pathlib import Path
from playwright.sync_api import sync_playwright
OUT=Path(__file__).parent/'identity/recovery-correctness'
r=json.loads((OUT/'findings.json').read_text());candidate=r['candidate_example']['local_candidate_evidence']['items'][0]
with sync_playwright() as p:
    browser=p.chromium.launch(channel='chrome',headless=True)
    page=browser.new_page(viewport={'width':1512,'height':1050});errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('http://127.0.0.1:5173/recovery?q=Eur%20Zuria')
    link=page.locator('a').filter(has_text='Έλεγχος:').filter(has_text='Eur Zuria').first
    link.wait_for(timeout=45000)
    assert page.get_by_text('Οι υποψήφιες συνδέσεις δεν είναι αποδεκτές ταυτότητες ή διαθέσιμα αρχεία.',exact=False).count()>0
    page.screenshot(path=str(OUT/'candidate-evidence.png'))
    page.locator(f'a[href="{candidate["review_url"]}"]').first.click()
    panel=page.locator('[id="candidate-local:547"]')
    panel.wait_for(timeout=45000)
    assert panel.get_attribute('open') is not None
    assert '82.23' in panel.inner_text()
    assert not errors,errors
    page.screenshot(path=str(OUT/'direct-review.png'))
    (OUT/'browser.json').write_text(json.dumps({'candidate_evidence_visible':True,'direct_review_opened':True,'page_errors':errors,'production_writes':0},indent=2))
    browser.close()
