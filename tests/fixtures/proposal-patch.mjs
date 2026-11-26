export function fullPatch(file, before, after) {
    const lines = text => text.replace(/\n$/, '').split('\n');
    const oldLines = lines(before), newLines = lines(after);
    return ['diff --git a/' + file + ' b/' + file, '--- a/' + file, '+++ b/' + file,
        '@@ -1,' + oldLines.length + ' +1,' + newLines.length + ' @@',
        ...oldLines.map(line => '-' + line), ...newLines.map(line => '+' + line), ''].join('\n');
}

export function taskData(prompt) {
    const start = prompt.indexOf('{', prompt.indexOf('## 任务数据\n'));
    for (let end = start + 1; end <= prompt.length; end++) {
        if (prompt[end - 1] !== '}') continue;
        try { return JSON.parse(prompt.slice(start, end)); } catch {}
    }
    throw new Error('缺少任务 JSON');
}
