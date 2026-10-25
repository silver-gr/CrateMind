import { expect, test } from 'bun:test';
import { pollJob } from '../src/lib/jobPolling';
import type { Job } from '../src/lib/types';

const job = (status: Job['status']): Job => ({ id: 1, kind: 'scan', status, total: 0, processed: 0, message: null, error: null, created_at: '', updated_at: '' });

test('polling remains attached past 600 active responses and completes only at terminal status', async () => {
  let reads = 0;
  const seen: string[] = [];
  const result = await pollJob({
    jobId: 1, read: async () => job(++reads > 605 ? 'done' : 'running'),
    onJob: current => seen.push(current.status), onConnection: () => {},
    wait: async () => {},
  });
  expect(reads).toBe(606);
  expect(result?.status).toBe('done');
  expect(seen.at(-2)).toBe('running');
});

test('connection loss and missing status are retried without pretending the job is idle', async () => {
  let reads = 0;
  const states: string[] = [];
  const result = await pollJob({
    jobId: 1, read: async () => {
      reads++;
      if (reads === 1) throw new Error('offline');
      if (reads === 2) return null;
      return job(reads === 3 ? 'running' : 'error');
    },
    onJob: () => {}, onConnection: state => states.push(state), wait: async () => {},
  });
  expect(result?.status).toBe('error');
  expect(states).toContain('retrying');
  expect(reads).toBe(4);
});

test('unmount cancellation prevents late responses updating the UI', async () => {
  const controller = new AbortController();
  let resolve!: (job: Job) => void;
  const values: Job[] = [];
  const request = pollJob({
    jobId: 1, signal: controller.signal, read: () => new Promise(done => { resolve = done; }),
    onJob: current => values.push(current), onConnection: () => {}, wait: async () => {},
  });
  controller.abort();
  resolve(job('done'));
  expect(await request).toBeNull();
  expect(values).toEqual([]);
});

test('discovery reconnects to persisted active work and resolves an empty history', async () => {
  const ids: (number | undefined)[] = [];
  const result = await pollJob({
    read: async id => { ids.push(id); return job(ids.length === 1 ? 'running' : 'done'); },
    onJob: () => {}, onConnection: () => {}, wait: async () => {},
  });
  expect(ids).toEqual([undefined, 1]);
  expect(result?.status).toBe('done');
  expect(await pollJob({ read: async () => null, onJob: () => {}, onConnection: () => {} })).toBeNull();
});
