import type { Job } from './types';

export type JobConnection = 'connecting' | 'connected' | 'retrying';

type Options = {
  jobId?: number;
  signal?: AbortSignal;
  read: (jobId?: number) => Promise<Job | null>;
  onJob: (job: Job) => void;
  onConnection: (state: JobConnection) => void;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

function waitForPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}

/** Follow a persisted job until terminal status or cancellation. Network loss
 * retains ownership and retries; it never means the server job became idle. */
export async function pollJob(options: Options): Promise<Job | null> {
  const { signal, read, onJob, onConnection, wait = waitForPoll } = options;
  let jobId = options.jobId;
  onConnection('connecting');
  while (!signal?.aborted) {
    try {
      const current = await read(jobId);
      if (signal?.aborted) return null;
      if (current) {
        jobId = current.id;
        onJob(current);
        onConnection('connected');
        if (current.status === 'done' || current.status === 'error') return current;
      } else if (jobId === undefined) {
        onConnection('connected');
        return null;
      } else {
        onConnection('retrying');
      }
    } catch {
      if (signal?.aborted) return null;
      onConnection('retrying');
    }
    await wait(1000, signal);
  }
  return null;
}
