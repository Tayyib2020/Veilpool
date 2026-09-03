export type RoundSchedule = {
  durationSeconds: number;
  startTimestamp?: number;
};

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
  lifecycleStage: "open" | "locked" | "draw" | "settled" | "cancelled" | "unavailable";
};

export type DepositParticipationCopy = {
  title: string;
  supporting?: string;
};

const DAY_SECONDS = 24 * 60 * 60;

function roundLabel(roundId?: bigint): string {
  return roundId === undefined ? "Round" : `Round #${roundId.toString()}`;
}

function scheduledEnd(schedule: RoundSchedule): number | undefined {
  if (schedule.startTimestamp === undefined || !Number.isFinite(schedule.startTimestamp) || !Number.isFinite(schedule.durationSeconds)) return undefined;
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

export function roundMonitorView(roundId: bigint | undefined, roundState: bigint | undefined, nowSeconds: number, schedule: RoundSchedule): RoundMonitorView {
  const label = roundLabel(roundId);
  const remaining = remainingScheduleSeconds(schedule, nowSeconds);
  if (roundState === undefined) {
    return { mode: "unavailable", title: "Round status unavailable", status: "Connect to view lifecycle", supporting: "The onchain round state will remain the source of truth.", roundLabel: label, lifecycleStage: "unavailable" };
  }

  switch (roundState) {
    case 0n:
      if (remaining !== undefined && remaining === 0) {
        return { mode: "awaiting-lock", title: "Awaiting round lock", status: "Schedule elapsed", supporting: "The scheduled participation window has ended. Waiting for the onchain round transition.", roundLabel: label, countdownSeconds: remaining, lifecycleStage: "open" };
      }
      if (remaining !== undefined && remaining <= DAY_SECONDS) {
        return { mode: "closing-soon", title: `${label} — Closing soon`, status: "Deposits open", supporting: "Eligibility will be frozen when the round is locked.", roundLabel: label, countdownSeconds: remaining, lifecycleStage: "open" };
      }
      return { mode: "live", title: `${label} — Live`, status: "Deposits open", supporting: "Deposits made before the round locks contribute to this round's encrypted, balance-weighted draw.", roundLabel: label, countdownSeconds: remaining, lifecycleStage: "open" };
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
      return { mode: "settled", title: `${label} — Settled`, status: "Prize draw complete", supporting: "This round is settled. Authorized participants can review their own private results.", roundLabel: label, lifecycleStage: "settled" };
    case 7n:
      return { mode: "cancelled", title: `${label} — Cancelled`, status: "Round closed", supporting: "This round ended without creating a prize.", roundLabel: label, lifecycleStage: "cancelled" };
    default:
      return { mode: "unavailable", title: "Round status unavailable", status: "Unknown onchain state", supporting: "The onchain round state will remain the source of truth.", roundLabel: label, lifecycleStage: "unavailable" };
  }
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
