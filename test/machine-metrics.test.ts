import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { availableMemory, cpuPercent, machineMetrics } from "../src/machine-metrics.js";

test("CPU uses interval deltas rather than lifetime or load average", () => {
  assert.equal(cpuPercent({ idle: 800, total: 1000 }, { idle: 850, total: 1200 }), 75);
  assert.equal(cpuPercent({ idle: 800, total: 1000 }, { idle: 800, total: 1000 }), null);
  assert.equal(cpuPercent({ idle: 800, total: 1000 }, { idle: 1, total: 10 }), null);
});
test("Linux memory includes reclaimable memory via MemAvailable", () => {
  assert.equal(availableMemory("MemTotal: 10000 kB\nMemFree: 100 kB\nMemAvailable:   4200 kB\n"), 4200 * 1024);
  assert.equal(availableMemory("MemFree: 100 kB\n"), null);
});
test("host metrics coalesce concurrent samples and tolerate missing disk", async () => {
  const sample = machineMetrics(tmpdir());
  const [a, b] = await Promise.all([sample(), sample()]);
  assert.deepEqual(a, b);
  assert.ok(a.cpu.cores > 0);
  assert.ok(a.memory.total > 0 && a.memory.used <= a.memory.total);
  assert.ok(a.disk && a.disk.total > 0 && a.disk.used <= a.disk.total);
  assert.ok(a.uptimeSeconds >= 0);
  assert.ok(a.processMemoryBytes > 0);
  assert.equal((await machineMetrics('/nonexistent-cogitator-metrics-path')()).disk, null);
});
