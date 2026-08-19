import { defineConfig } from "vitest/config";

/**
 * Timeouts sized for what the tests wait on, not for what they cost.
 *
 * A timeout exists to catch a hang. Vitest's defaults are 5 seconds for a test
 * and 10 for a hook, which is generous against the work here and not against
 * the machine running it.
 *
 * What that cost: the release run for v0.13.0 failed on Windows and skipped
 * the publish, because `init` in an empty repo passed 5 seconds. That call
 * writes about fifteen small files and takes 27 milliseconds on a laptop. The
 * same job had `exit-code.test.ts` spending 14 seconds on 28 CLI spawns, so
 * the runner was contended rather than the test being slow. Re-running the
 * same commit passed with nothing changed.
 *
 * Two numbers, because two different clocks were exposed. `testTimeout` covers
 * the test bodies that write files or spawn the CLI. `hookTimeout` covers
 * `test/init.test.ts`, which makes a temporary directory before each test and
 * removes the tree after it, on the same contended disk.
 *
 * 30 seconds is deliberately far above any real run. A hang still fails, six
 * times slower than before, and that is the whole price.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
