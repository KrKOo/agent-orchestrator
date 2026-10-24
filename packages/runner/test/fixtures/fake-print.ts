/** Stands in for `omp -p` in runJob tests: prints the prompt text, or fails when told to. */
const text = process.argv[2] ?? "";
if (text.includes("fail")) {
  process.stderr.write("boom\n");
  process.exit(3);
}
process.stdout.write(`print:${text}\n`);
