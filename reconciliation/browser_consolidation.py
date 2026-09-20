"""Browser proof: read-only against live; mutations only against isolated port 8011."""
import argparse,json,sqlite3
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'reconciliation/identity/consolidation'
parser=argparse.ArgumentParser();parser.add_argument('--live',action='store_true');args=parser.parse_args()
manifest=json.loads((OUT/('manifest.json' if args.live else 'trial.json')).read_text())
example=next(d for d in manifest['decisions'] if len(d['absorbed'])>=2 and len(d['representatives'])==1)
rep=example['representatives'][0];source=example['absorbed'][0]
db=sqlite3.connect(OUT/('before.sqlite' if args.live else 'trial.sqlite'));name=db.execute('SELECT name FROM collections WHERE id=?',(source,)).fetchone()[0];db.close()
errors=[]
with sync_playwright() as p:
 b=p.chromium.launch(channel='chrome',headless=True);page=b.new_page(viewport={'width':1512,'height':1080})
 page.add_init_script("localStorage.setItem('cm:sidebar-collapsed','0')")
 if not args.live:
  def isolated(route):
   response=route.fetch(url=route.request.url.replace('http://localhost:5173/api/identity','http://127.0.0.1:8011/api/identity'))
   route.fulfill(response=response)
  page.route('**/api/identity/**',isolated)
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(f'http://localhost:5173/collections?id={rep}')
 expect(page.get_by_text(f"{manifest['after']} συλλογές",exact=True)).to_be_visible(timeout=30000)
 page.screenshot(path=str(OUT/('library-live.png' if args.live else 'library-isolated.png')))
 search=page.get_by_role('textbox',name='Αναζήτηση συλλογών');search.fill(name)
 expect(page.get_by_text('1 συλλογές',exact=True)).to_be_visible(timeout=30000)
 page.get_by_text('Πηγές & ιστορικό',exact=False).click()
 expect(page.get_by_role('link',name=name,exact=True)).to_be_visible()
 page.screenshot(path=str(OUT/('history-live.png' if args.live else 'history-isolated.png')))
 page.get_by_text('Σύγκριση & πράξεις συλλογών',exact=True).last.click()
 page.get_by_role('button',name='Δεξιά συλλογή (προαιρετική)',exact=True).last.click()
 page.get_by_placeholder('Αναζήτηση συλλογής…').last.fill(name)
 options=page.get_by_role('option').filter(has_text=name.removesuffix('.csv'))
 # Display title may remove technical suffixes; identify the selected option by canonical ID.
 expect(page.locator(f'[cmdk-item][data-value="{rep}"]')).to_be_visible()
 visible=page.locator('[cmdk-item]:visible');assert visible.count() in (1,2)
 page.keyboard.press('Escape')
 page.goto('http://localhost:5173/collections')
 page.get_by_text('Ενοποίηση συλλογών — αποφάσεις περιεχομένου',exact=False).click()
 page.get_by_role('textbox',name='Αναζήτηση ομάδων ενοποίησης').fill('freeyourmind')
 page.get_by_role('button',name='Σύγκριση επιλογής',exact=True).click()
 expect(page.get_by_text('Οι ημερομηνίες είναι παρατηρήσεις.',exact=False)).to_be_visible(timeout=30000)
 page.screenshot(path=str(OUT/('review-live.png' if args.live else 'review-isolated.png')))
 if not args.live:
  page.goto(f'http://localhost:5173/collections?id={rep}')
  page.get_by_text('Πηγές & ιστορικό',exact=False).click()
  page.get_by_role('button',name='Επαναφορά ως ξεχωριστή',exact=True).first.click()
  expect(page.get_by_text(f"{manifest['after']+1} συλλογές",exact=True)).to_be_visible(timeout=30000)
  page.get_by_text('Πηγές & ιστορικό',exact=False).click()
  page.get_by_role('button',name='Αναίρεση ενοποίησης',exact=True).click()
  expect(page.get_by_text(f"{manifest['after']+len(example['absorbed'])-1} συλλογές",exact=True)).to_be_visible(timeout=30000)
 assert not errors,errors
 (OUT/('browser-live.json' if args.live else 'browser-isolated.json')).write_text(json.dumps({'passed':True,'live_mutations':False,'active_count':manifest['after'],'alias':name,'representative':rep,'source':source,'errors':errors,'isolated_restore_undo':not args.live},indent=2))
 b.close()
