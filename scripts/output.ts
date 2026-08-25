/**
 * Where the CLI commands send their output. Routed through a replaceable sink so tests can capture
 * it without stubbing `process.stdout.write` itself, which the test reporter also writes through,
 * silencing its own results and under-counting the suite.
 */
export const output = {
  write(text: string): void {
    process.stdout.write(text);
  },
  error(text: string): void {
    process.stderr.write(text);
  },
};
