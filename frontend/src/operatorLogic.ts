import type { RoundState } from "./appLogic";

const OPERATOR_ROUND_STATES = [
  "OPEN",
  "LOCKED",
  "AWAITING_TOTAL_DECRYPTION",
  "DRAW_READY",
  "DRAWING",
  "RETRY_REQUIRED",
  "SETTLED",
  "CANCELLED",
] as const;

export type OperatorAccess = "missing_configuration" | "disconnected" | "wrong_network" | "authorized" | "unauthorized";

export function operatorAddressMatches(connectedAddress?: string, operatorAddress?: string): boolean {
  return Boolean(connectedAddress && operatorAddress && connectedAddress.toLowerCase() === operatorAddress.toLowerCase());
}

export function operatorAccessState(input: {
  walletStatus: "unsupported" | "disconnected" | "connecting" | "connected" | "wrong-network" | "error";
  connectedAddress?: string;
  operatorAddress?: string;
  hasOperatorConfiguration: boolean;
}): OperatorAccess {
  if (!input.hasOperatorConfiguration || !input.operatorAddress) return "missing_configuration";
  if (input.walletStatus === "wrong-network") return "wrong_network";
  if (input.walletStatus !== "connected" || !input.connectedAddress) return "disconnected";
  return operatorAddressMatches(input.connectedAddress, input.operatorAddress) ? "authorized" : "unauthorized";
}

export type OperatorAction =
  | "request_principal_deployment"
  | "finalize_principal_deployment"
  | "finalize_principal_unwrap"
  | "restore_principal_liquidity"
  | "harvest_yield"
  | "lock_round"
  | "request_aggregate_decryption"
  | "finalize_aggregate_reveal"
  | "commit_harvested_yield"
  | "close_empty_round"
  | "cancel_no_yield_round"
  | "execute_draw"
  | "request_draw_acceptance"
  | "finalize_draw_acceptance"
  | "start_next_round";

export type OperatorActionInput = {
  state: RoundState | "UNKNOWN";
  participantCount: bigint;
  publicTotalWeight?: bigint;
  unallocatedHarvestedYield: bigint;
  prizeCommitted: boolean;
  acceptanceDecryptionRequested: boolean;
  adapterConfigured: boolean;
  principalSyncPending: boolean;
  principalUnwrapPending: boolean;
  principalDeployed: bigint;
};

export function availableOperatorActions(input: OperatorActionInput): OperatorAction[] {
  const actions: OperatorAction[] = [];
  if (input.adapterConfigured && input.state === "OPEN") {
    if (!input.principalSyncPending && !input.principalUnwrapPending) actions.push("request_principal_deployment");
    actions.push("harvest_yield");
  }
  if (input.principalSyncPending) actions.push("finalize_principal_deployment");
  if (input.principalUnwrapPending) actions.push("finalize_principal_unwrap");
  if (input.adapterConfigured && input.principalDeployed > 0n) actions.push("restore_principal_liquidity");

  switch (input.state) {
    case "OPEN":
      if (input.participantCount >= 2n) actions.push("lock_round");
      break;
    case "LOCKED":
      actions.push("request_aggregate_decryption");
      break;
    case "AWAITING_TOTAL_DECRYPTION":
      actions.push("finalize_aggregate_reveal");
      break;
    case "DRAW_READY":
      if (input.publicTotalWeight === 0n) actions.push("close_empty_round");
      else if (!input.prizeCommitted && input.unallocatedHarvestedYield === 0n) actions.push("cancel_no_yield_round");
      if (!input.prizeCommitted && input.unallocatedHarvestedYield > 0n) actions.push("commit_harvested_yield");
      if (input.prizeCommitted && input.publicTotalWeight !== 0n) actions.push("execute_draw");
      break;
    case "DRAWING":
      if (input.acceptanceDecryptionRequested) actions.push("finalize_draw_acceptance");
      else actions.push("request_draw_acceptance");
      break;
    case "RETRY_REQUIRED":
      if (input.prizeCommitted) actions.push("execute_draw");
      break;
    case "SETTLED":
    case "CANCELLED":
      actions.push("start_next_round");
      break;
    default:
      break;
  }
  return actions;
}

export function lifecycleIndex(state: RoundState | "UNKNOWN"): number {
  const index = OPERATOR_ROUND_STATES.indexOf(state as (typeof OPERATOR_ROUND_STATES)[number]);
  return index < 0 ? -1 : index;
}
