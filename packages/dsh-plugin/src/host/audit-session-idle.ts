import { setTimeout as delay } from 'node:timers/promises';
import { addAbortListener } from 'node:events';
import type { AuditSessionHost } from './index.js';

interface SessionState {
    cursor: number;
    active: boolean;
    running: boolean;
    queue: unknown[] | null;
    pendingInput: unknown[];
}

interface SessionEvent {
    type: string;
    data?: { source?: { rpcId?: string }; reason?: { kind?: string } };
}

interface AuditAgent {
    status: 'idle' | 'running';
    inbox: { nextTurn: unknown[]; nextStep: unknown[] };
    session: { seq: number; snapshotEvents(from: number): readonly SessionEvent[] };
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

interface SessionController {
    cancel?(request: { sessionId: string }): unknown;
    wait(request: { sessionId: string; timeoutMs: number; maxMessages: number }, signal: AbortSignal):
        Promise<{ reason: 'idle' | 'input-required' | 'timeout'; state: SessionState }>;
    state(request: { sessionId: string }, signal: AbortSignal): Promise<SessionState>;
}

function isIdle(state: SessionState): boolean {
    return state.active === true && state.running === false && Array.isArray(state.queue) && state.queue.length === 0
        && Array.isArray(state.pendingInput) && state.pendingInput.length === 0;
}

function completed(events: readonly SessionEvent[], requestId: string): boolean {
    const admitted = events.findIndex(event => event.type === 'user/message' && event.data?.source?.rpcId === requestId);
    if (admitted < 0) return false;
    let ended = false;
    for (const event of events.slice(admitted + 1)) {
        if (event.type === 'turn/start') ended = false;
        if (event.type === 'turn/end') {
            if (event.data?.reason?.kind !== 'completed') return false;
            ended = true;
        }
    }
    return ended;
}

export async function stopDshAuditSession(host: AuditSessionHost, sessionId: string, signal: AbortSignal,
    processStopped: Promise<boolean>): Promise<boolean> {
    const controller = host.get('sessionController') as SessionController | undefined;
    const subagents = host.get('subagents') as {
        listDescendants(sessionId: string, signal: AbortSignal): Promise<unknown[]>;
    } | undefined;
    if (typeof controller?.cancel !== 'function' || typeof controller.state !== 'function'
        || typeof subagents?.listDescendants !== 'function') return false;
    signal.throwIfAborted();
    await controller.cancel({ sessionId });
    if (!await processStopped) return false;
    while (!signal.aborted) {
        const state = await controller.state({ sessionId }, signal);
        if (isIdle(state)) {
            const descendants = await subagents.listDescendants(sessionId, signal);
            const fresh = await controller.state({ sessionId }, signal);
            if (fresh.cursor === state.cursor && isIdle(fresh) && Array.isArray(descendants) && !descendants.length) return true;
        }
        await delay(500, undefined, { signal });
    }
    return false;
}

export async function withDshAuditSessionIdle(
    host: AuditSessionHost, sessionId: string, requestId: string, signal: AbortSignal,
    finalize: (signal: AbortSignal) => Promise<void | false>,
): Promise<boolean> {
    const controller = host.get('sessionController') as SessionController | undefined;
    const agents = host.get('agents') as { get(id: string): AuditAgent | undefined } | undefined;
    const goals = host.get('goals') as { get(agent: AuditAgent): { phase: string } | undefined } | undefined;
    const subagents = host.get('subagents') as {
        waitForTreeWork(agent: AuditAgent): Promise<boolean>;
        listDescendants(sessionId: string, signal: AbortSignal): Promise<unknown[]>;
    } | undefined;
    if (typeof controller?.wait !== 'function' || typeof controller.state !== 'function'
        || typeof agents?.get !== 'function' || typeof goals?.get !== 'function'
        || typeof subagents?.waitForTreeWork !== 'function' || typeof subagents.listDescendants !== 'function') return false;

    while (!signal.aborted) {
        const { reason, state } = await controller.wait({ sessionId, timeoutMs: 30_000, maxMessages: 1 }, signal);
        if (!state.active) return false;
        if (reason === 'idle' && isIdle(state)) {
            const agent = agents.get(sessionId);
            if (!agent || typeof agent.runMaintenance !== 'function'
                || typeof agent.session?.snapshotEvents !== 'function') return false;
            const canFinalize = (sample: SessionState): boolean => {
                if (!isIdle(sample) || agents.get(sessionId) !== agent || agent.status !== 'idle'
                    || agent.session.seq - 1 !== sample.cursor || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) return false;
                const goal = goals.get(agent);
                return (!goal || goal.phase === 'complete') && completed(agent.session.snapshotEvents(0), requestId);
            };
            if (canFinalize(state)) {
                signal.throwIfAborted();
                let onAbort: ReturnType<typeof addAbortListener> | undefined;
                try {
                    const abort = new Promise<never>((_, reject) => {
                        onAbort = addAbortListener(signal, () => reject(signal.reason));
                    });
                    await Promise.race([subagents.waitForTreeWork(agent), abort]);
                } finally {
                    onAbort?.[Symbol.dispose]();
                }
                let entered = false;
                try {
                    signal.throwIfAborted();
                    const finalized = await agent.runMaintenance(async maintenance => {
                        entered = true;
                        const combined = AbortSignal.any([signal, maintenance]);
                        const descendants = await subagents.listDescendants(sessionId, combined);
                        // 根会话维护窗无法拦截直接投递给子会话的新输入。
                        if (!Array.isArray(descendants) || descendants.length) return 'manual';
                        const fresh = await controller.state({ sessionId }, combined);
                        combined.throwIfAborted();
                        if (fresh.cursor !== state.cursor || !canFinalize(fresh)) return false;
                        return await finalize(combined) !== false;
                    });
                    if (finalized === 'manual') return false;
                    if (finalized) return true;
                } catch (error) {
                    if (entered || signal.aborted) throw error;
                }
            }
        }
        if (reason !== 'timeout') await delay(1000, undefined, { signal });
    }
    return false;
}
