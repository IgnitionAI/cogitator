import { useEffect, useState } from "react";
import type { MachineMetrics } from "../../src/machine-types";
import { api } from "./api";
import { formatNumber, formatTime, t } from "./i18n";
import { Modal } from "./ui";
import "./machine.css";

const percent = (value: number | null | undefined) => value == null ? "—" : `${formatNumber(Math.round(value))} %`;
const bytes = (value: number) => `${formatNumber(value / 1024 ** 3, { maximumFractionDigits: 1 })} GiB`;
export function MachineStatus() {
  const [metrics, setMetrics] = useState<MachineMetrics | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let closed = false;
    let busy = false;
    const refresh = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try { const value = await api.machineMetrics(); if (!closed) { setMetrics(value); setFailed(false); } }
      catch { if (!closed) setFailed(true); }
      finally { busy = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => { closed = true; clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  const data = failed ? null : metrics;
  const gauge = (label: string, value: number | null | undefined, detail: string) => (
    <section className="machine-gauge">
      <div><strong>{label}</strong><span>{percent(value)}</span></div>
      {value != null ? <progress max={100} value={value} aria-label={label} /> : null}
      <small>{detail}</small>
    </section>
  );
  return <>
    <button type="button" className="machine-summary" aria-label={t("machine.open")} onClick={() => setOpen(true)}>
      <span>{t("machine.cpu")} <strong>{percent(data?.cpu.percent)}</strong></span>
      <span>{t("machine.ram")} <strong>{percent(data?.memory.percent)}</strong></span>
    </button>
    {open ? <Modal title={t("machine.title")} onClose={() => setOpen(false)}>
      <div className="machine-panel">
        <p className="muted">{t("machine.scope")}</p>
        {!data ? <p role="status">{t(failed ? "machine.unavailable" : "machine.measuring")}</p> : <>
          {gauge(t("machine.cpu"), data.cpu.percent, t("machine.cores", { count: data.cpu.cores }))}
          {gauge(t("machine.memory"), data.memory.percent, t("machine.used", { used: bytes(data.memory.used), total: bytes(data.memory.total) }))}
          {gauge(t("machine.disk"), data.disk?.percent, data.disk ? `${t("machine.used", { used: bytes(data.disk.used), total: bytes(data.disk.total) })} · ${t("machine.free", { amount: bytes(data.disk.available) })}` : t("machine.unavailable"))}
          <dl><dt>{t("machine.uptime")}</dt><dd>{t("machine.duration", { days: Math.floor(data.uptimeSeconds / 86400), hours: Math.floor(data.uptimeSeconds / 3600) % 24, minutes: Math.floor(data.uptimeSeconds / 60) % 60 })}</dd>
          <dt>{t("machine.process")}</dt><dd>{bytes(data.processMemoryBytes)}</dd></dl>
          <small>{t("machine.updated", { time: formatTime(data.sampledAt) })}</small>
        </>}
      </div>
    </Modal> : null}
  </>;
}
