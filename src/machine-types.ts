export interface MachineMetrics {
  sampledAt: string;
  cpu: { percent: number | null; cores: number };
  memory: { used: number; total: number; percent: number };
  disk: { used: number; total: number; available: number; percent: number } | null;
  uptimeSeconds: number;
  processMemoryBytes: number;
}
