import path from 'node:path';
import process from 'node:process';
import { runProcess } from './shell.js';
import { runGateChecks } from './validator.js';

export function configuredAuditStageGates(): typeof runGateChecks | undefined {
    const sandbox = process.env['DSH_AUDIT_GATE_SANDBOX'];
    if (!sandbox || !path.isAbsolute(sandbox)) return undefined;
    const env = Object.fromEntries(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'LANG'].flatMap(key => {
        const value = process.env[key];
        return value === undefined ? [] : [[key, value]];
    }));
    return (commands, options) => runGateChecks(commands, {
        ...options,
        run: (command, processOptions) => runProcess(sandbox, [processOptions.cwd, command], {
            ...processOptions, env, inheritEnv: false, killTreeOnExit: true,
        }),
    });
}
