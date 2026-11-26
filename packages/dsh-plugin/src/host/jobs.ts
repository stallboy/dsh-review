import type { JobRecord } from './types.js';

export type JobType = JobRecord['type'];

const MAX_JOBS = 40;
const MAX_LOG_LINES = 4000;

export interface JobContext {
  id: string;
  log: (line: string) => void;
  signal: AbortSignal;
}

export interface JobIncrementalView {
  job: JobRecord;
  log: string[];
  logOffset: number;
  totalLogLines: number;
  earliestLogOffset: number;
  logResetRequired: boolean;
}

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly controllers = new Map<string, AbortController>();

  start(type: JobType, task: (ctx: JobContext) => Promise<unknown>): JobRecord {
    const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const record: JobRecord = {
      id,
      type,
      status: 'running',
      startedAt: new Date().toISOString(),
      log: [],
      logStartOffset: 0,
    };
    this.jobs.set(id, record);
    this.prune();
    const log = (line: string): void => this.appendLog(id, line);
    void (async () => {
      try {
        record.result = await task({ id, log, signal: controller.signal });
        record.status = 'succeeded';
      } catch (error) {
        record.status = 'failed';
        record.error = error instanceof Error ? error.message : String(error);
        log(`失败：${record.error}`);
      } finally {
        this.controllers.delete(id);
        record.finishedAt = new Date().toISOString();
      }
    })();
    return record;
  }

  appendLog(id: string, line: string): void {
    const record = this.jobs.get(id);
    if (!record) return;
    record.log.push(line);
    record.logStartOffset ??= 0;
    if (record.log.length > MAX_LOG_LINES) {
      const dropped = record.log.length - MAX_LOG_LINES;
      record.log.splice(0, dropped);
      record.logStartOffset += dropped;
    }
  }

  abort(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
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

  /** SPEC §5.7：单调递增绝对行序号，窗口截断时提示 logResetRequired 而非丢行。 */
  getIncremental(id: string, since?: number): JobIncrementalView | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const earliest = job.logStartOffset ?? 0;
    const total = earliest + job.log.length;
    if (since === undefined || since < 0) {
      return {
        job,
        log: [...job.log],
        logOffset: total,
        totalLogLines: total,
        earliestLogOffset: earliest,
        logResetRequired: false,
      };
    }
    if (since < earliest) {
      return {
        job,
        log: [...job.log],
        logOffset: total,
        totalLogLines: total,
        earliestLogOffset: earliest,
        logResetRequired: true,
      };
    }
    const startIdx = Math.min(job.log.length, Math.max(0, since - earliest));
    return {
      job,
      log: job.log.slice(startIdx),
      logOffset: total,
      totalLogLines: total,
      earliestLogOffset: earliest,
      logResetRequired: false,
    };
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }
}
