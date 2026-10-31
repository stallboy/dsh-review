// Stand-in for a broken executor: consumes the prompt and exits non-zero.
for await (const _chunk of process.stdin) {
  // Drain stdin so the parent can finish writing the prompt.
}
process.stderr.write('fake audit agent failed intentionally\n');
process.exit(1);
