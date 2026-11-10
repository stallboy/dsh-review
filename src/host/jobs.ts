import type { JobRecord } from './types.js';

export type JobType = JobRecord['type'];

const MAX_JOBS = 40;
const MAX_LOG_LINES = 4000;

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  /** §7.7：运行中 Job 的取消信号，用于终止 Runner 进程树。 */
  private readonly controllers = new Map<string, AbortController>();

  start(type: JobType, task: (log: (line: string) => void, id: string, signal: AbortSignal) => Promise<unknown>): JobRecord {
    const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const controller = new AbortController();
    this.controllers.set(id, controller);
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
      record.logStartOffset ??= 0;
      if (record.log.length > MAX_LOG_LINES) {
        const dropped = record.log.length - MAX_LOG_LINES;
        record.log.splice(0, dropped);
        // §8.2/G36：日志偏移使用单调递增绝对序号——截断不丢失后续行。
        record.logStartOffset += dropped;
      }
    };
    void (async () => {
      try {
        record.result = await task(log, id, controller.signal);
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

  /** §7.7：请求取消运行中的 Job（终止 Runner 进程树/会话）。 */
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

  list(): JobRecord[] {
    return [...this.jobs.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }
}
