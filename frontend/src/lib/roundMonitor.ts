import { useEffect, useMemo, useState } from "react";

export type RoundSchedule = {
  durationSeconds: number;
  startTimestamp?: number;
  phase?: "open" | "next";
  targetRoundId?: bigint | string;
};

export type PersistedPublicRoundSchedule =
  | { phase: "open"; roundId: string; scheduledStart: number; durationSeconds: number }
  | { phase: "next"; targetRoundId: string; scheduledStart: number; durationSeconds: number };

export const PUBLIC_ROUND_SCHEDULE_STORAGE_KEY = "veilpool.public-round-schedule.v1";

export type RoundMonitorMode =
  | "live"
  | "closing-soon"
  | "awaiting-lock"
  | "locked"
  | "preparing-draw"
  | "drawing"
  | "retry-required"
  | "settled"
  | "cancelled"
  | "unavailable";

export type RoundMonitorView = {
  mode: RoundMonitorMode;
  title: string;
  status: string;
  supporting: string;
  roundLabel: string;
  countdownSeconds?: number;
  scheduleHeading?: string;
  scheduleTitle?: string;
  scheduleSupporting?: string;
  countdownLabel?: string;
  lifecycleStage: "open" | "locked" | "draw" | "settled" | "cancelled" | "unavailable";
};

export type DepositParticipationCopy = {
  title: string;
  supporting?: string;
};

const DAY_SECONDS = 24 * 60 * 60;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): StorageLike | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function validSchedule(value: unknown): value is PersistedPublicRoundSchedule {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if ((candidate.phase !== "open" && candidate.phase !== "next") || typeof candidate.scheduledStart !== "number" || !Number.isFinite(candidate.scheduledStart) || typeof candidate.durationSeconds !== "number" || !Number.isFinite(candidate.durationSeconds) || candidate.durationSeconds <= 0) return false;
  if (candidate.phase === "open") return typeof candidate.roundId === "string";
  return typeof candidate.targetRoundId === "string";
}

export function readPublicRoundSchedule(storage: StorageLike | undefined = browserStorage()): PersistedPublicRoundSchedule | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(PUBLIC_ROUND_SCHEDULE_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return validSchedule(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function persistPublicRoundSchedule(schedule: PersistedPublicRoundSchedule, storage: StorageLike | undefined = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(PUBLIC_ROUND_SCHEDULE_STORAGE_KEY, JSON.stringify(schedule));
  } catch {
    // Storage is an enhancement; the onchain lifecycle remains authoritative.
  }
}

function sameSchedule(left: PersistedPublicRoundSchedule | undefined, right: PersistedPublicRoundSchedule | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function advancePublicRoundSchedule(current: PersistedPublicRoundSchedule | undefined, roundId: bigint | undefined, roundState: bigint | undefined, nowSeconds: number, configured: RoundSchedule): PersistedPublicRoundSchedule | undefined {
  if (roundId === undefined || roundState === undefined || !Number.isFinite(nowSeconds) || !Number.isFinite(configured.durationSeconds) || configured.durationSeconds <= 0) return current;
  const id = roundId.toString();
  const durationSeconds = Math.floor(configured.durationSeconds);
  if (roundState === 6n || roundState === 7n) {
    const targetRoundId = (roundId + 1n).toString();
    if (current?.phase === "next" && current.targetRoundId === targetRoundId && current.durationSeconds === durationSeconds) return current;
    return { phase: "next", targetRoundId, scheduledStart: Math.floor(nowSeconds) + durationSeconds, durationSeconds };
  }
  if (roundState === 0n) {
    if (current?.phase === "next" && current.targetRoundId === id && current.durationSeconds === durationSeconds) {
      return { phase: "open", roundId: id, scheduledStart: current.scheduledStart, durationSeconds };
    }
    if (current?.phase === "open" && current.roundId === id && current.durationSeconds === durationSeconds) return current;
    return { phase: "open", roundId: id, scheduledStart: configured.startTimestamp ?? Math.floor(nowSeconds), durationSeconds };
  }
  return current;
}

export function usePublicRoundSchedule(roundId: bigint | undefined, roundState: bigint | undefined, nowSeconds: number, configured: RoundSchedule): RoundSchedule {
  const [persisted, setPersisted] = useState<PersistedPublicRoundSchedule | undefined>(() => readPublicRoundSchedule());
  const resolved = useMemo(() => advancePublicRoundSchedule(persisted, roundId, roundState, nowSeconds, configured), [configured.durationSeconds, configured.startTimestamp, nowSeconds, persisted, roundId, roundState]);
  useEffect(() => {
    if (sameSchedule(persisted, resolved) || !resolved) return;
    setPersisted(resolved);
    persistPublicRoundSchedule(resolved);
  }, [persisted, resolved]);
  if (!resolved) return configured;
  return { durationSeconds: resolved.durationSeconds, startTimestamp: resolved.scheduledStart, phase: resolved.phase, targetRoundId: resolved.phase === "next" ? resolved.targetRoundId : resolved.roundId };
}

function roundLabel(roundId?: bigint): string {
  return roundId === undefined ? "Round" : `Round #${roundId.toString()}`;
}

function scheduledEnd(schedule: RoundSchedule): number | undefined {
  if (schedule.startTimestamp === undefined || !Number.isFinite(schedule.startTimestamp) || !Number.isFinite(schedule.durationSeconds)) return undefined;
  if (schedule.phase === "next") return schedule.startTimestamp;
  return schedule.startTimestamp + Math.max(0, schedule.durationSeconds);
}

export function remainingScheduleSeconds(schedule: RoundSchedule, nowSeconds: number): number | undefined {
  const end = scheduledEnd(schedule);
  if (end === undefined) return undefined;
  return Math.max(0, end - Math.max(0, nowSeconds));
}

export function formatRoundCountdown(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(safeSeconds / DAY_SECONDS);
  const hours = Math.floor((safeSeconds % DAY_SECONDS) / (60 * 60));
  const minutes = Math.floor((safeSeconds % (60 * 60)) / 60);
  return `${days}d ${hours.toString().padStart(2, "0")}h ${minutes.toString().padStart(2, "0")}m`;
}

export function formatRoundClockCountdown(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / (60 * 60));
  const minutes = Math.floor((safeSeconds % (60 * 60)) / 60);
  const seconds = safeSeconds % 60;
  return `${hours.toString().padStart(2, "0")} : ${minutes.toString().padStart(2, "0")} : ${seconds.toString().padStart(2, "0")}`;
}

export function roundMonitorView(roundId: bigint | undefined, roundState: bigint | undefined, nowSeconds: number, schedule: RoundSchedule): RoundMonitorView {
  const label = roundLabel(roundId);
  const remaining = remainingScheduleSeconds(schedule, nowSeconds);
  if (roundState === undefined) {
    return { mode: "unavailable", title: "Round status unavailable", status: "Connect to view lifecycle", supporting: "The onchain round state will remain the source of truth.", roundLabel: label, lifecycleStage: "unavailable" };
  }

  switch (roundState) {
    case 0n:
      if (remaining !== undefined && remaining === 0) {
        return { mode: "awaiting-lock", title: "Awaiting round lock", status: "Schedule elapsed", supporting: "The scheduled participation window has ended. Waiting for the onchain round transition.", scheduleHeading: "ROUND READY TO LOCK", scheduleSupporting: "The deposit window has ended. Waiting for the operator to lock the round onchain.", countdownSeconds: remaining, countdownLabel: "", roundLabel: label, lifecycleStage: "open" };
      }
      if (remaining !== undefined && remaining <= DAY_SECONDS) {
        return { mode: "closing-soon", title: `${label} — Closing soon`, status: "Deposits open", supporting: "Eligibility will be frozen when the round is locked.", scheduleHeading: `${label.toUpperCase()} · DEPOSITS OPEN`, scheduleTitle: "Draw ready in", scheduleSupporting: "Private deposits remain open until the scheduled draw window.", countdownSeconds: remaining, countdownLabel: "", roundLabel: label, lifecycleStage: "open" };
      }
      return { mode: "live", title: `${label} — Live`, status: "Deposits open", supporting: "Deposits made before the round locks contribute to this round's encrypted, balance-weighted draw.", scheduleHeading: `${label.toUpperCase()} · DEPOSITS OPEN`, scheduleTitle: "Draw ready in", scheduleSupporting: "Private deposits remain open until the scheduled draw window.", countdownSeconds: remaining, countdownLabel: "", roundLabel: label, lifecycleStage: "open" };
    case 1n:
      return { mode: "locked", title: `${label} — Locked`, status: "Eligibility snapshot complete", supporting: "Deposits for this draw are no longer changing its eligibility snapshot.", roundLabel: label, lifecycleStage: "locked" };
    case 2n:
    case 3n:
      return { mode: "preparing-draw", title: "Preparing encrypted draw", status: "Aggregate preparation", supporting: "Aggregate eligibility and decryption preparation are underway. Individual eligibility remains confidential.", roundLabel: label, lifecycleStage: "draw" };
    case 4n:
      return { mode: "drawing", title: "Encrypted draw in progress", status: "Selecting privately", supporting: "VeilPool is selecting the winner using encrypted, balance-weighted eligibility.", roundLabel: label, lifecycleStage: "draw" };
    case 5n:
      return { mode: "retry-required", title: "Draw retry required", status: "Fresh encrypted randomness needed", supporting: "The draw can be retried with a fresh encrypted randomness batch. Participant funds are not at risk.", roundLabel: label, lifecycleStage: "draw" };
    case 6n:
      return closedRoundView("settled", label, roundId, remaining, "This round is settled. Authorized participants can review their own private results.");
    case 7n:
      return closedRoundView("cancelled", label, roundId, remaining, "This round ended without creating a prize.");
    default:
      return { mode: "unavailable", title: "Round status unavailable", status: "Unknown onchain state", supporting: "The onchain round state will remain the source of truth.", roundLabel: label, lifecycleStage: "unavailable" };
  }
}

function closedRoundView(mode: "settled" | "cancelled", label: string, roundId: bigint | undefined, remaining: number | undefined, supporting: string): RoundMonitorView {
  const nextLabel = roundId === undefined ? "the next round" : `Round #${(roundId + 1n).toString()}`;
  const ready = remaining !== undefined && remaining === 0;
  return { mode, title: `${label} — ${mode === "settled" ? "Settled" : "Cancelled"}`, status: mode === "settled" ? "Prize draw complete" : "Round closed", supporting, scheduleHeading: ready ? "ROUND READY" : "NEXT ROUND", scheduleTitle: ready ? `${nextLabel} is ready to open` : `${nextLabel} begins in`, scheduleSupporting: ready ? "The scheduled start time has arrived. Waiting for the operator to open the next round onchain." : "A new 24-hour deposit window is scheduled after each round.", countdownSeconds: remaining, countdownLabel: "", roundLabel: label, lifecycleStage: mode };
}

export function depositParticipationMessage(view: RoundMonitorView): string {
  const copy = depositParticipationCopy(view);
  return [copy.title, copy.supporting].filter(Boolean).join(" ");
}

export function depositParticipationCopy(view: RoundMonitorView): DepositParticipationCopy {
  if (view.mode === "live" || view.mode === "closing-soon") {
    return { title: `Deposit now to participate in ${view.roundLabel}.` };
  }
  if (view.mode === "awaiting-lock") {
    return {
      title: `${view.roundLabel} is still open, but its scheduled window has ended.`,
      supporting: "The onchain round transition is still pending.",
    };
  }
  if (view.mode === "locked" || view.mode === "preparing-draw" || view.mode === "drawing" || view.mode === "retry-required") {
    return {
      title: `${view.roundLabel} eligibility is frozen.`,
      supporting: "New deposits are held in VeilPool for the next round and will not affect the already-frozen current round.",
    };
  }
  if (view.mode === "settled") {
    return {
      title: `${view.roundLabel} is settled.`,
      supporting: "New deposits are held in VeilPool for the next round. They become eligible when the operator opens and locks that round.",
    };
  }
  if (view.mode === "cancelled") {
    return {
      title: `${view.roundLabel} is cancelled.`,
      supporting: "New deposits are held in VeilPool for the next round. They become eligible when the operator opens and locks that round.",
    };
  }
  return { title: "Connect to read the current onchain round before depositing." };
}

export function depositEmptyStateMessage(view: RoundMonitorView): string {
  if (view.mode === "live" || view.mode === "closing-soon") {
    return "Make your first private deposit to join the current prize round.";
  }
  return "Make a private deposit for the next prize round.";
}
