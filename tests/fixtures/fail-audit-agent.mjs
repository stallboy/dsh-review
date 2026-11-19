for await (const _chunk of process.stdin) {
  // 先读完 stdin，让父进程有机会完整写入提示词，再模拟执行失败。
}
process.stderr.write('fake audit agent failed intentionally\n');
process.exit(1);
