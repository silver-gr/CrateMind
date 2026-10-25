import {expect, test} from 'bun:test';
import {renderToString} from 'react-dom/server';
import {ConsolidationReview} from '../src/components/CollectionConsolidation';
import CollectionAlgebra from '../src/components/CollectionAlgebra';
import {collectionOriginLabel} from '../src/lib/collectionLabels';

test('closed review and algebra panels do not mount their controls', () => {
  const review=renderToString(<ConsolidationReview onChanged={()=>{}}/>);
  expect(review).toContain('Έλεγχος παρόμοιων συλλογών');
  expect(review).not.toContain('Αναζήτηση ομάδων ενοποίησης');
  const algebra=renderToString(<CollectionAlgebra left="a" onSaved={()=>{}}/>);
  expect(algebra).not.toContain('Δεξιά συλλογή');
  const embedded=renderToString(<CollectionAlgebra embedded left="a" onSaved={()=>{}}/>);
  expect(embedded).toContain('Δεξιά συλλογή');
});

test('generated native wrappers display original services and accounts', () => {
  expect(collectionOriginLabel({service:'cratemind',source_services:['cratemind','soundcloud'],source_accounts:['7149789']})).toBe('SoundCloud · DJ PanoramixXX');
  expect(collectionOriginLabel({service:'cratemind'})).toBe('CrateMind');
  expect(collectionOriginLabel({service:'cratemind',source_services:['spotify'],source_accounts:['account1','account2']})).toBe('Spotify · account1 · account2');
});
