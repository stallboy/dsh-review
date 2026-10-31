import type { JobRecord } from './types.js';

export type JobType = JobRecord['type'];

const MAX_JOBS = 40;
const MAX_LOG_LINES = 4000;

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();

  start(type: JobType, task: (log: (line: string) => void, id: string) => Promise<unknown>): JobRecord {
    const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const record: JobRecord = {
      id,
      type,
      status: 'running',
      startedAt: new Date().toISOString(),
      log: [],
    };
    this.jobs.set(id, record);
    this.prune();
    const log = (line: string): void => {
      record.log.push(line);
      if (record.log.length > MAX_LOG_LINES) record.log.splice(0, record.log.length - MAX_LOG_LINES);
    };
    void (async () => {
      try {
        record.result = await task(log, id);
        record.status = 'succeeded';
      } catch (error) {
        record.status = 'failed';
        record.error = error instanceof Error ? error.message : String(error);
        log(`失败：${record.error}`);
      } finally {
        record.finishedAt = new Date().toISOString();
      }
    })();
    return record;
  }

  private prune(): void {
    if (this.jobs.size <= MAX_JOBS) return;
    const finished = [...this.jobs.values()]
      .filter((job) => job.status !== 'running')
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    for (const job of finished.slice(0, this.jobs.size - MAX_JOBS)) this.jobs.delete(job.id);
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }
}
