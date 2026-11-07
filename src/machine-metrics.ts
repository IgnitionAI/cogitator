import { cpus, freemem, totalmem, uptime } from "node:os";
import { readFile, statfs } from "node:fs/promises";

import type { MachineMetrics } from "./machine-types.js";
export function cpuPercent(before: { idle: number; total: number }, after: { idle: number; total: number }): number | null {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  return total > 0 && idle >= 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : null;
}
export function availableMemory(meminfo: string): number | null {
  const value = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  return value ? Number(value[1]) * 1024 : null;
}
function cpuSnapshot() {
  const cores = cpus();
  return { cores: cores.length, idle: cores.reduce((sum, c) => sum + c.times.idle, 0), total: cores.reduce((sum, c) => sum + Object.values(c.times).reduce((a, b) => a + b, 0), 0) };
}
/** Host metrics, not a container/service resource quota. No shell or arbitrary path input. */
export function machineMetrics(home: string) {
  let previous = cpuSnapshot();
  let lastAt = performance.now();
  let cached: MachineMetrics | undefined;
  let pending: Promise<MachineMetrics> | undefined;
  return function sample(): Promise<MachineMetrics> {
    if (cached && performance.now() - lastAt < 2000) return Promise.resolve(cached);
    if (pending) return pending;
    pending = (async () => {
      const cpu = cpuSnapshot();
      const elapsed = performance.now() - lastAt;
      const percent = elapsed >= 500 ? cpuPercent(previous, cpu) : null;
      const total = totalmem();
      let available = freemem();
      if (process.platform === "linux") {
        available = await readFile("/proc/meminfo", "utf8").then(s => availableMemory(s) ?? available).catch(() => available);
      }
      const used = Math.max(0, Math.min(total, total - available));
      const disk = await statfs(home).then(s => {
        const total = s.blocks * s.bsize;
        const used = (s.blocks - s.bfree) * s.bsize;
        return { total, used, available: s.bavail * s.bsize, percent: total > 0 ? used / total * 100 : 0 };
      }).catch(() => null);
      previous = cpu; lastAt = performance.now();
      cached = { sampledAt: new Date().toISOString(), cpu: { percent, cores: cpu.cores }, memory: { used, total, percent: total > 0 ? used / total * 100 : 0 }, disk, uptimeSeconds: uptime(), processMemoryBytes: process.memoryUsage().rss };
      return cached;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
