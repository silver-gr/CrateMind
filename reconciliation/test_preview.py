import csv, io, json, sqlite3, tempfile, unittest, zipfile
from pathlib import Path
from preview import parse_spotify, candidate_evidence, clean, key, build_preview, read_rows, sha, snapshot, ro_db

class ParserTests(unittest.TestCase):
 def make_zip(self,entries):
  tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);p=Path(tmp.name)/'input.zip'
  with zipfile.ZipFile(p,'w') as z:
   for name,headers,rows in entries:
    s=io.StringIO();w=csv.writer(s);w.writerow(headers);w.writerows(rows);z.writestr(name,s.getvalue().encode('utf-8-sig'))
  return p
 def test_online_backup_includes_wal_and_source_is_read_only(self):
  tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);root=Path(tmp.name);p=root/'live.sqlite'
  c=sqlite3.connect(p);c.execute('pragma journal_mode=WAL');c.execute('create table evidence(id integer)');c.commit();c.execute('pragma wal_checkpoint(TRUNCATE)');c.execute('insert into evidence values (75)');c.commit()
  dest=root/'snapshot.sqlite';snapshot(p,dest)
  r=ro_db(dest);self.assertEqual(r.execute('select id from evidence').fetchone()[0],75);r.close()
  source=ro_db(p)
  with self.assertRaises(sqlite3.OperationalError):source.execute('delete from evidence')
  source.close();c.close()
 def test_multilingual_and_explicit_likes(self):
  for account,likes,headers in [('account1','liked.csv',['URI κομματιού','Όνομα κομματιού','Διάρκεια κομματιού (ms)']),('account3','Liked_Songs.csv',['Track URI','Track Name','Duration (ms)'])]:
   p=self.make_zip([(likes,headers,[['spotify:track:one','Δοκιμή','120000']]),('liked_songs.csv',headers,[['spotify:episode:two','Mix','300000']])])
   cc,mm,ii,oo=parse_spotify(p,account)
   self.assertEqual(sum(c['is_likes'] for c in cc),1);self.assertEqual(len(mm),2);self.assertEqual(ii['spotify:track:one']['duration_ms'],120000)
   self.assertEqual(ii['spotify:episode:two']['type'],'episode');self.assertIn('Δοκιμή',str(oo))
 def test_duplicate_names_empty_repeats_missing_ids_rerun(self):
  h=['Track URI','Track Name'];p=self.make_zip([('liked.csv',h,[]),('same.csv',h,[['spotify:track:x','X'],['spotify:track:x','X'],['','Unknown']]),('same.csv',h,[])])
  first=parse_spotify(p,'account1');self.assertEqual(first,parse_spotify(p,'account1'))
  cc,mm,ii,oo=first;self.assertEqual(len({c['collection_id'] for c in cc}),3);self.assertEqual([m['position'] for m in mm],[0,1,2]);self.assertEqual(len({m['membership_id'] for m in mm}),3)
  self.assertEqual(len(ii),2);self.assertTrue(mm[2]['source_item_id'].startswith('unknown:'));self.assertEqual(len(oo),3)
 def test_unicode_line_separator_in_metadata(self):
  tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);p=Path(tmp.name)/'rows.jsonl'
  p.write_text(json.dumps({'title':'first\u2028second'},ensure_ascii=False)+'\n',encoding='utf-8')
  self.assertEqual(read_rows(p),[{'title':'first\u2028second'}])
 def test_unknown_schema_rejected(self):
  p=self.make_zip([('liked.csv',['Wrong'],[['x']])])
  with self.assertRaises(ValueError):parse_spotify(p,'account1')
 def test_tokens_and_embedded_urls_redacted(self):
  r=clean({'secret_token':'SECRET','description':'see https://soundcloud.com/a/b/s-private?oauth_token=BAD', 'raw_json':'{"authorization":"BAD"}'})
  self.assertNotIn('SECRET',str(r));self.assertNotIn('BAD',str(r));self.assertNotIn('s-private',str(r))
 def test_candidate_version_and_duration_not_auto_merge(self):
  a={'title':'Song (Live)','isrc':'XX123','duration_ms':100000,'performer':'X','type':'track'}
  b={'title':'Song (Remix)','isrc':'XX123','duration_ms':200000,'performer':'X','type':'track'}
  e=candidate_evidence(a,b);self.assertIn('version_tokens_differ',e['flags']);self.assertIn('duration_differs',e['flags']);self.assertFalse(e['score_is_probability'])
 def test_multiple_local_assets_and_remote_only(self):
  tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);p=Path(tmp.name)/'audio.mp3';p.write_bytes(b'fixture')
  cc=[{'collection_id':'c','service':'soundcloud','is_likes':False,'name':'Preview'}]
  mm=[{'collection_id':'c','position':i,'source_item_id':s} for i,s in enumerate(['soundcloud:tracks:1','soundcloud:tracks:2'])]
  ii={s:{'title':s,'availability':'unknown'} for s in ['soundcloud:tracks:1','soundcloud:tracks:2']}
  ll=[{'id':i,'absolute_path':str(p),'missing':False,'title':'fixture'} for i in [1,2]]
  aa=[{'track_id':i,'soundcloud_track_id':1,'method':'manual_review'} for i in [1,2]]
  v=build_preview(cc,mm,ii,ll,aa,[]);self.assertEqual(len(v['source_entries'][0]['local_assets']),2);self.assertEqual(v['source_entries'][1]['state'],'remote_only_unresolved');self.assertEqual(len(v['proposed_local_collection']['entries']),2)

class SnapshotTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.out=Path(__file__).parent/'runs/20260914-preview'
  if not (cls.out/'metrics.json').exists():raise unittest.SkipTest('Run preview first for snapshot checks')
  cls.metrics=json.loads((cls.out/'metrics.json').read_text());cls.members=read_rows(cls.out/'source_memberships.jsonl');cls.items=read_rows(cls.out/'source_items.jsonl')
 def test_verified_source_counts(self):
  m=self.metrics;self.assertEqual(m['spotify_likes_uri_union'],5648);self.assertEqual(m['spotify_music_uri_union'],11172);self.assertEqual(m['soundcloud_likes'],4724);self.assertEqual(m['soundcloud_unknown_likes'],75);self.assertEqual(m['soundcloud_playlist_positions'],8777)
 def test_all_positions_and_remote_only_retained(self):
  groups={};ids={r['source_item_id'] for r in self.items}
  for m in self.members:
   self.assertIn(m['source_item_id'],ids);groups.setdefault(m['collection_id'],[]).append(m['position'])
  for c in read_rows(self.out/'source_collections.jsonl'):
   self.assertEqual(sorted(groups.get(c['collection_id'],[])),list(range(c['track_count'])))
  self.assertEqual(len({m['membership_id'] for m in self.members}),len(self.members))
 def test_existing_decisions_preserved(self):
  a=read_rows(self.out/'accepted_links.jsonl');h=read_rows(self.out/'existing_candidate_history.jsonl');self.assertEqual(len(a),545);self.assertEqual(sum(r['status']=='rejected' for r in h),4)
  self.assertEqual(len({r['soundcloud_track_id'] for r in a}),531)
 def test_production_preservation(self):
  p=json.loads((self.out/'source_preservation.json').read_text());self.assertTrue(p['all_logical_tables_unchanged']);self.assertTrue(p['input_hashes_unchanged']);self.assertTrue(p['snapshot_equals_initial_live_logical_tables'])
 def test_preview_exact_source_positions(self):
  p=json.loads((self.out/'collection_preview.json').read_text());cid=p['source_snapshot']['collection_id'];source=[m for m in self.members if m['collection_id']==cid]
  self.assertEqual([(m['position'],m['source_item_id']) for m in source],[(m['position'],m['source_item_id']) for m in p['source_entries']]);self.assertIn('remote_only_unresolved',{r['state'] for r in p['source_entries']});self.assertIn('local_asset_present',{r['state'] for r in p['source_entries']})

if __name__=='__main__':unittest.main()
