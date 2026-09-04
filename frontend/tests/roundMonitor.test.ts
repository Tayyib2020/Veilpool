import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  advancePublicRoundSchedule,
  depositEmptyStateMessage,
  depositParticipationCopy,
  depositParticipationMessage,
  formatRoundCountdown,
  formatRoundClockCountdown,
  persistPublicRoundSchedule,
  readPublicRoundSchedule,
  remainingScheduleSeconds,
  roundMonitorView,
} from "../src/lib/roundMonitor.ts";

const schedule = { durationSeconds: 7 * 24 * 60 * 60, startTimestamp: 1_000_000 };
const at = (secondsAfterStart: number) => 1_000_000 + secondsAfterStart;

test("maps an open round with time remaining to live deposits", () => {
  const view = roundMonitorView(1n, 0n, at(60), schedule);
  assert.equal(view.mode, "live");
  assert.equal(view.status, "Deposits open");
  assert.equal(view.countdownSeconds, schedule.durationSeconds - 60);
  assert.match(depositParticipationMessage(view), /participate in Round #1/);
});

test("marks an open round closing soon inside the final 24 hours", () => {
  const view = roundMonitorView(1n, 0n, at(schedule.durationSeconds - 24 * 60 * 60), schedule);
  assert.equal(view.mode, "closing-soon");
  assert.equal(view.title, "Round #1 — Closing soon");
});

test("shows awaiting round lock after the informational schedule elapses", () => {
  const view = roundMonitorView(1n, 0n, at(schedule.durationSeconds), schedule);
  assert.equal(view.mode, "awaiting-lock");
  assert.equal(view.countdownSeconds, 0);
  assert.match(view.supporting, /Waiting for the onchain round transition/);
  assert.match(depositParticipationMessage(view), /onchain round transition/);
});

test("never invents LOCKED when the onchain state remains OPEN", () => {
  const view = roundMonitorView(1n, 0n, at(schedule.durationSeconds + 500), schedule);
  assert.equal(view.mode, "awaiting-lock");
  assert.notEqual(view.title, "Round #1 — Locked");
});

test("onchain locked state overrides remaining frontend time", () => {
  const view = roundMonitorView(1n, 1n, at(60), schedule);
  assert.equal(view.mode, "locked");
  assert.equal(view.title, "Round #1 — Locked");
  assert.equal(view.countdownSeconds, undefined);
  assert.match(depositParticipationMessage(view), /Round #1 eligibility is frozen/);
  assert.match(depositParticipationMessage(view), /will not affect the already-frozen current round/);
});

test("maps aggregate preparation states without exposing individual eligibility", () => {
  assert.equal(roundMonitorView(1n, 2n, at(60), schedule).mode, "preparing-draw");
  assert.equal(roundMonitorView(1n, 3n, at(60), schedule).mode, "preparing-draw");
  assert.match(roundMonitorView(1n, 2n, at(60), schedule).supporting, /Individual eligibility remains confidential/);
});

test("maps drawing, retry, settled, and cancelled states", () => {
  assert.equal(roundMonitorView(1n, 4n, at(60), schedule).mode, "drawing");
  assert.equal(roundMonitorView(1n, 5n, at(60), schedule).mode, "retry-required");
  assert.equal(roundMonitorView(1n, 6n, at(60), schedule).title, "Round #1 — Settled");
  assert.equal(roundMonitorView(1n, 7n, at(60), schedule).mode, "cancelled");
});

test("uses next-round wording after settlement and cancellation", () => {
  const settled = roundMonitorView(1n, 6n, at(60), schedule);
  const cancelled = roundMonitorView(1n, 7n, at(60), schedule);
  const settledCopy = depositParticipationCopy(settled);
  const cancelledCopy = depositParticipationCopy(cancelled);

  assert.equal(settledCopy.title, "Round #1 is settled.");
  assert.match(settledCopy.supporting ?? "", /held in VeilPool for the next round/);
  assert.equal(depositEmptyStateMessage(settled), "Make a private deposit for the next prize round.");
  assert.equal(cancelledCopy.title, "Round #1 is cancelled.");
  assert.match(cancelledCopy.supporting ?? "", /operator opens and locks/);
  assert.doesNotMatch(depositParticipationMessage(settled), /Eligible for Round #1|Join Round #1|Participating in Round #1/i);
});

test("keeps active-round copy and frozen-round warnings distinct", () => {
  const openCopy = depositParticipationCopy(roundMonitorView(3n, 0n, at(60), schedule));
  const lockedCopy = depositParticipationCopy(roundMonitorView(3n, 1n, at(60), schedule));
  const drawingCopy = depositParticipationCopy(roundMonitorView(3n, 4n, at(60), schedule));

  assert.equal(openCopy.title, "Deposit now to participate in Round #3.");
  assert.match(lockedCopy.title, /eligibility is frozen/);
  assert.match(lockedCopy.supporting ?? "", /will not affect/);
  assert.match(drawingCopy.title, /eligibility is frozen/);
  assert.match(drawingCopy.supporting ?? "", /next round/);
  assert.equal(depositEmptyStateMessage(roundMonitorView(3n, 0n, at(60), schedule)), "Make your first private deposit to join the current prize round.");
});

test("does not use joinedRoundOf for membership messaging", () => {
  const userAppSource = readFileSync(new URL("../src/UserApp.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(userAppSource, /joinedRoundOf/);
});

test("clamps countdowns to zero and formats them accessibly", () => {
  assert.equal(remainingScheduleSeconds(schedule, at(schedule.durationSeconds + 99)), 0);
  assert.equal(formatRoundCountdown(-1), "0d 00h 00m");
  assert.equal(formatRoundCountdown(4 * 24 * 60 * 60 + 7 * 60 * 60 + 31 * 60), "4d 07h 31m");
});

test("handles missing or invalid schedule timestamps without inventing a deadline", () => {
  const noStart = roundMonitorView(1n, 0n, 1_000_000, { durationSeconds: schedule.durationSeconds });
  assert.equal(noStart.mode, "live");
  assert.equal(noStart.countdownSeconds, undefined);
  const invalid = roundMonitorView(1n, 0n, 1_000_000, { durationSeconds: Number.NaN, startTimestamp: 1_000_000 });
  assert.equal(invalid.mode, "live");
  assert.equal(invalid.countdownSeconds, undefined);
});

test("keeps disconnected or unavailable monitor state non-mutating", () => {
  const view = roundMonitorView(undefined, undefined, at(60), schedule);
  assert.equal(view.mode, "unavailable");
  assert.match(depositParticipationMessage(view), /Connect to read/);
});

test("creates a persisted public 24-hour next-round anchor after settlement", () => {
  const current = advancePublicRoundSchedule(undefined, 1n, 6n, 2_000, { durationSeconds: 24 * 60 * 60 });
  assert.deepEqual(current, { phase: "next", targetRoundId: "2", scheduledStart: 88_400, durationSeconds: 86_400 });
  const storage = new Map<string, string>();
  const storageLike = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) };
  persistPublicRoundSchedule(current!, storageLike);
  assert.deepEqual(readPublicRoundSchedule(storageLike), current);
  assert.equal(storage.get("veilpool.public-round-schedule.v1")?.includes("wallet"), false);
});

test("renders settled ready-to-open and open ready-to-lock schedule states", () => {
  const settled = roundMonitorView(1n, 6n, 88_400, { phase: "next", targetRoundId: "2", startTimestamp: 88_400, durationSeconds: 86_400 });
  assert.equal(settled.scheduleHeading, "ROUND READY");
  assert.equal(settled.scheduleTitle, "Round #2 is ready to open");
  assert.match(settled.scheduleSupporting ?? "", /Waiting for the operator/);

  const open = roundMonitorView(2n, 0n, 2_000, { phase: "open", roundId: "2", startTimestamp: 1_000, durationSeconds: 86_000 });
  assert.equal(open.scheduleHeading, "ROUND #2 · DEPOSITS OPEN");
  assert.equal(open.scheduleTitle, "Draw ready in");
  assert.equal(open.countdownSeconds, 85_000);
  assert.equal(roundMonitorView(2n, 0n, 87_001, { phase: "open", roundId: "2", startTimestamp: 1_001, durationSeconds: 86_000 }).scheduleHeading, "ROUND READY TO LOCK");
});

test("formats the schedule as an HH : MM : SS public countdown", () => {
  assert.equal(formatRoundClockCountdown(86_400), "24 : 00 : 00");
  assert.equal(formatRoundClockCountdown(3_661), "01 : 01 : 01");
  assert.equal(formatRoundClockCountdown(-1), "00 : 00 : 00");
});

test("schedule state survives wallet changes without storing wallet data", () => {
  const current = advancePublicRoundSchedule(undefined, 1n, 6n, 10_000, { durationSeconds: 86_400 });
  const afterWalletChange = advancePublicRoundSchedule(current, undefined, undefined, 20_000, { durationSeconds: 86_400 });
  assert.deepEqual(afterWalletChange, current);
  assert.doesNotMatch(JSON.stringify(current), /address|wallet|account|private/i);
});
