import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, parseUnits, type BrowserProvider, type TransactionResponse } from "ethers";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  ExternalLink,
  LockKeyhole,
  Network,
  RefreshCw,
  ShieldCheck,
  WalletCards,
  X,
} from "lucide-react";
import { Button, ConnectedWalletMenu, ThemeToggle, VeilPoolLoader, VeilPoolLogo, WalletSelector } from "./components";
import { formatAddress, operationError, roundStateDescription, roundStateLabel, safeErrorDetails, type RoundState } from "./appLogic";
import { availableOperatorActions, lifecycleIndex, operatorAccessState, type OperatorAccess, type OperatorAction } from "./operatorLogic";
import { contractsConfigured, contractConfig, explorerTxUrl, roundSchedule } from "./config/contracts";
import { publicDecryptHandle, readContracts, waitForTransaction, yieldAdapterContract, type ReadContracts } from "./lib/veilpoolClient";
import { formatRoundClockCountdown, roundMonitorView, usePublicRoundSchedule, type RoundMonitorView } from "./lib/roundMonitor";
import { useCurrentRoundDepositEvidence } from "./lib/roundParticipants";
import { displayErrorMessage, useWallet, type WalletState } from "./wallet";
import "./operator.css";

const OPERATOR_ASSET = "/images/dashboard-operator.png";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type OperatorPublicState = {
  engineOperator?: string;
  adapterAddress?: string;
  roundId?: bigint;
  roundState?: bigint;
  participantCount: bigint;
  maxParticipants: bigint;
  publicTotalWeight?: bigint;
  roundPrizeAmount?: bigint;
  unallocatedHarvestedYield: bigint;
  prizeCommitted: boolean;
  acceptanceDecryptionRequested: boolean;
  principalSyncPending: boolean;
  principalUnwrapPending: boolean;
  pendingPrincipalUnwrapRequest?: string;
  publicPrincipalLiability?: bigint;
  principalDeployed: bigint;
  managedAssets: bigint;
  generatedYield: bigint;
  healthAvailable: boolean;
  tokenDecimals: number;
};

type OperatorOperation = {
  action: OperatorAction;
  label: string;
  status: "preparing" | "waiting_wallet" | "submitted" | "confirming" | "complete" | "failed";
  txHash?: string;
  error?: string;
};

const EMPTY_STATE: OperatorPublicState = {
  participantCount: 0n,
  maxParticipants: 10n,
  unallocatedHarvestedYield: 0n,
  prizeCommitted: false,
  acceptanceDecryptionRequested: false,
  principalSyncPending: false,
  principalUnwrapPending: false,
  principalDeployed: 0n,
  managedAssets: 0n,
  generatedYield: 0n,
  healthAvailable: false,
  tokenDecimals: 6,
};

const LIFECYCLE: RoundState[] = ["OPEN", "LOCKED", "AWAITING_TOTAL_DECRYPTION", "DRAW_READY", "DRAWING", "RETRY_REQUIRED", "SETTLED", "CANCELLED"];

const ACTION_COPY: Record<OperatorAction, { title: string; description: string; toast: string }> = {
  request_principal_deployment: { title: "Request principal sync", description: "Request an authorized public reveal of aggregate principal before deployment. Individual balances remain encrypted.", toast: "Principal restoration requested." },
  finalize_principal_deployment: { title: "Finalize principal sync", description: "Verify the public aggregate principal proof and begin the asynchronous unwrap when additional liquidity is required.", toast: "Principal synchronization finalized." },
  finalize_principal_unwrap: { title: "Finalize principal restoration", description: "Verify the wrapper’s public unwrap proof and deposit the returned principal into the configured yield adapter.", toast: "Principal restoration finalized." },
  restore_principal_liquidity: { title: "Restore principal liquidity", description: "Withdraw deployed principal from the yield adapter back to the VeilPool liquid balance for user withdrawals.", toast: "Principal liquidity restored." },
  harvest_yield: { title: "Harvest generated yield", description: "Move adapter surplus into the separate confidential prize reserve. Principal is not harvested.", toast: "Generated yield harvested." },
  lock_round: { title: "Lock round", description: "Freeze the current participant and eligibility snapshot for the encrypted draw.", toast: "Round locked." },
  request_aggregate_decryption: { title: "Request aggregate total", description: "Make only the frozen aggregate eligibility total publicly decryptable for verification.", toast: "Aggregate total requested." },
  finalize_aggregate_reveal: { title: "Finalize aggregate total", description: "Verify the asynchronous public proof for the frozen aggregate total and advance the round to draw-ready.", toast: "Aggregate total finalized." },
  commit_harvested_yield: { title: "Commit generated yield", description: "Allocate a selected public slice of harvested yield as this round’s separate prize.", toast: "Generated yield committed." },
  close_empty_round: { title: "Close empty round", description: "Close this round because the verified aggregate eligible balance is zero. No winner or prize is created.", toast: "Empty round closed." },
  cancel_no_yield_round: { title: "Cancel no-yield round", description: "Close this draw-ready round because no harvested yield is available and no prize has been committed.", toast: "No-yield round cancelled." },
  execute_draw: { title: "Start encrypted draw", description: "Run the bounded encrypted draw. The operator triggers the process but cannot provide or choose the result.", toast: "Encrypted draw started." },
  request_draw_acceptance: { title: "Request draw result", description: "Make only the encrypted acceptance bit publicly decryptable. Candidates and winner identity remain private.", toast: "Draw acceptance requested." },
  finalize_draw_acceptance: { title: "Finalize draw result", description: "Verify the public acceptance proof; the encrypted contract logic credits the winner without exposing their identity.", toast: "Draw acceptance finalized." },
  start_next_round: { title: "Start next round", description: "Open the next protocol round after the current round has settled or been validly cancelled.", toast: "Next round opened." },
};

const CONFIRM_ACTIONS = new Set<OperatorAction>([
  "request_principal_deployment",
  "finalize_principal_unwrap",
  "restore_principal_liquidity",
  "lock_round",
  "execute_draw",
  "close_empty_round",
  "cancel_no_yield_round",
  "start_next_round",
]);

function safeBigInt(value: unknown): bigint {
  return BigInt(String(value));
}

function stateLabel(value?: bigint): RoundState | "UNKNOWN" {
  return value === undefined ? "UNKNOWN" : roundStateLabel(value);
}

function publicAmount(value: bigint | undefined, decimals: number): string {
  if (value === undefined) return "Unavailable";
  return `${formatUnits(value, decimals)} vPOOL`;
}

async function loadOperatorCoreState(contracts: ReadContracts): Promise<OperatorPublicState> {
  const [participantCount, maxParticipants, tokenDecimals] = await Promise.all([
    contracts.vault.participantCount(),
    contracts.vault.maxParticipants(),
    contracts.token.decimals().catch(() => 6),
  ]);
  const state: OperatorPublicState = {
    ...EMPTY_STATE,
    participantCount: safeBigInt(participantCount),
    maxParticipants: safeBigInt(maxParticipants),
    tokenDecimals: Number(tokenDecimals),
  };
  if (!contracts.engine) return state;

  const [engineOperator, roundId, roundState, publicTotalWeight, roundPrizeAmount, unallocatedHarvestedYield, prizeCommitted, acceptanceDecryptionRequested, principalSyncPending, principalUnwrapPending, pendingPrincipalUnwrapRequest, publicPrincipalLiability, adapterAddress] = await Promise.all([
    contracts.engine.operator(),
    contracts.engine.roundId(),
    contracts.engine.roundState(),
    contracts.engine.publicTotalWeight(),
    contracts.engine.roundPrizeAmount(),
    contracts.engine.unallocatedHarvestedYield(),
    contracts.engine.prizeCommitted(),
    contracts.engine.acceptanceDecryptionRequested(),
    contracts.engine.principalLiabilityRevealRequested(),
    contracts.engine.principalUnwrapPending(),
    contracts.engine.pendingPrincipalUnwrapRequest(),
    contracts.engine.publicPrincipalLiability(),
    contracts.engine.yieldAdapter(),
  ]);
  state.engineOperator = String(engineOperator);
  state.roundId = safeBigInt(roundId);
  state.roundState = safeBigInt(roundState);
  state.publicTotalWeight = safeBigInt(publicTotalWeight);
  state.roundPrizeAmount = safeBigInt(roundPrizeAmount);
  state.unallocatedHarvestedYield = safeBigInt(unallocatedHarvestedYield);
  state.prizeCommitted = Boolean(prizeCommitted);
  state.acceptanceDecryptionRequested = Boolean(acceptanceDecryptionRequested);
  state.principalSyncPending = Boolean(principalSyncPending);
  state.principalUnwrapPending = Boolean(principalUnwrapPending);
  state.pendingPrincipalUnwrapRequest = String(pendingPrincipalUnwrapRequest);
  state.publicPrincipalLiability = safeBigInt(publicPrincipalLiability);
  state.adapterAddress = String(adapterAddress);
  if (state.adapterAddress === ZERO_ADDRESS) state.adapterAddress = contractConfig.yieldAdapter;
  return state;
}

async function loadOperatorHealthState(
  contracts: ReadContracts,
  provider: BrowserProvider,
  coreState: OperatorPublicState,
): Promise<Pick<OperatorPublicState, "principalDeployed" | "managedAssets" | "generatedYield" | "healthAvailable">> {
  if (!coreState.adapterAddress) return { principalDeployed: 0n, managedAssets: 0n, generatedYield: 0n, healthAvailable: false };
  const adapter = contracts.yieldAdapter ?? yieldAdapterContract(provider, coreState.adapterAddress);
  const [principalDeployed, managedAssets, generatedYield] = await Promise.all([
    adapter.principalDeployed(),
    adapter.managedAssets(),
    adapter.generatedYield(),
  ]);
  return {
    principalDeployed: safeBigInt(principalDeployed),
    managedAssets: safeBigInt(managedAssets),
    generatedYield: safeBigInt(generatedYield),
    healthAvailable: true,
  };
}

function NetworkStatus({ wallet, onSwitch }: { wallet: WalletState; onSwitch: () => void }) {
  if (wallet.status === "wrong-network") return <button className="operator-network operator-network--warning" onClick={onSwitch}><Network size={14} /> Switch to Sepolia</button>;
  if (wallet.status === "connected") return <span className="operator-network operator-network--ready"><span className="operator-status-dot" /> Sepolia</span>;
  return <span className="operator-network"><Network size={14} /> Sepolia</span>;
}

function Toasts({ toasts }: { toasts: string[] }) {
  return <div className="operator-toasts" aria-live="polite" aria-atomic="true">{toasts.map((toast, index) => <motion.div className="operator-toast" key={`${toast}-${index}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}><Check size={15} /> {toast}</motion.div>)}</div>;
}

function AccessState({ access, onConnect, onSwitch }: { access: OperatorAccess; onConnect: () => void; onSwitch: () => void }) {
  if (access === "missing_configuration") return <section className="operator-state operator-state--config"><CircleHelp size={22} /><div><span className="operator-kicker">Development state</span><h1>Operator environment not configured.</h1><p>Sepolia contract and operator addresses are required before protocol operations can begin.</p><small>Set VITE_VEILPOOL_ADDRESS, VITE_PRIZE_ENGINE_ADDRESS, and VITE_OPERATOR_ADDRESS in <code>frontend/.env</code>. The operator address is cross-checked against the PrizeEngine when the wallet connects.</small></div></section>;
  if (access === "wrong_network") return <section className="operator-state"><Network size={22} /><div><span className="operator-kicker">Wrong network</span><h1>VeilPool operator actions run on Sepolia.</h1><p>Switch the connected wallet to Sepolia before operating the protocol.</p><Button onClick={onSwitch}>Switch to Sepolia <ArrowUpRight size={15} /></Button></div></section>;
  if (access === "unauthorized") return <section className="operator-state"><CircleAlert size={22} /><div><span className="operator-kicker">Operator access required</span><h1>This wallet is not authorized to operate VeilPool.</h1><p>Contracts remain the source of truth for operator authorization. No actionable controls are exposed here.</p><a className="operator-back-link" href="/app"><ArrowLeft size={14} /> Back to dashboard</a></div></section>;
  if (access === "disconnected") return <section className="operator-state"><WalletCards size={22} /><div><span className="operator-kicker">Operator access</span><h1>Connect the authorized operator wallet.</h1><p>Protocol controls remain hidden until a wallet is connected and checked against PrizeEngine.operator().</p><Button onClick={onConnect}>Connect wallet <ArrowUpRight size={15} /></Button></div></section>;
  return null;
}

function PrivacyBoundary() {
  return <section className="operator-boundary"><div className="operator-section-heading"><span className="operator-kicker">Privacy boundary</span><h2>Operate the pool.<br /><em>Never inspect the people in it.</em></h2></div><div className="operator-boundary__columns"><div><strong><Check size={16} /> Visible to operator</strong><ul><li>Round state and lifecycle</li><li>Participant count and limit</li><li>Intentionally public aggregate values</li><li>Protocol health and transaction state</li></ul></div><div><strong><X size={16} /> Never visible to operator</strong><ul><li>Individual savings</li><li>Individual eligibility</li><li>Individual winnings</li><li>Private winner result or secret RNG target</li></ul></div></div></section>;
}

function Lifecycle({ current }: { current: RoundState | "UNKNOWN" }) {
  const currentIndex = lifecycleIndex(current);
  return <section className="operator-lifecycle"><div className="operator-section-heading"><span className="operator-kicker">Round lifecycle</span><h2>Public state,<br /><em>encrypted selection.</em></h2></div><div className="operator-lifecycle__list">{LIFECYCLE.map((state, index) => <div className={`operator-lifecycle__step${state === current ? " is-current" : ""}${currentIndex >= 0 && index < currentIndex ? " is-complete" : ""}`} key={state}><span className="operator-lifecycle__marker">{currentIndex >= 0 && index < currentIndex ? <Check size={13} /> : index + 1}</span><div><strong>{state.replaceAll("_", " ")}</strong><small>{state === current ? "Current protocol state" : index < currentIndex ? "Complete" : "Awaiting state transition"}</small></div>{index < LIFECYCLE.length - 1 && <ArrowRight className="operator-lifecycle__arrow" size={15} />}</div>)}</div><p className="operator-lifecycle__note"><ShieldCheck size={15} /> Winner selection is generated by encrypted draw logic. The operator triggers the process; the operator does not provide the result.</p></section>;
}

function ScheduleNotice({ view }: { view: RoundMonitorView }) {
  if (!view.scheduleHeading) return null;
  return <div className={`operator-schedule operator-schedule--${view.mode}`} aria-label="Public round schedule"><span>{view.scheduleHeading}</span>{view.scheduleTitle && <strong>{view.scheduleTitle}</strong>}{view.countdownSeconds !== undefined && <strong className="operator-schedule__countdown">{formatRoundClockCountdown(view.countdownSeconds)}</strong>}<p>{view.scheduleSupporting}</p></div>;
}

function ConfirmDialog({ action, onCancel, onConfirm }: { action: OperatorAction; onCancel: () => void; onConfirm: () => void }) {
  const copy = ACTION_COPY[action];
  return <div className="operator-dialog-backdrop" role="presentation"><section className="operator-dialog" role="dialog" aria-modal="true" aria-labelledby="operator-dialog-title"><button className="operator-dialog__close" aria-label="Close confirmation" onClick={onCancel}><X size={17} /></button><span className="operator-kicker">Confirm operator action</span><h2 id="operator-dialog-title">{copy.title}?</h2><p>{copy.description}</p><div className="operator-dialog__actions"><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button onClick={onConfirm}>{copy.title} <ArrowUpRight size={15} /></Button></div></section></div>;
}

export default function OperatorPanel() {
  const reduced = useReducedMotion();
  const { wallet, walletOptions, walletSelectionOpen, connect, closeWalletSelection, resetWallet, switchToSepolia } = useWallet();
  const [contracts, setContracts] = useState<ReadContracts>();
  const [state, setState] = useState<OperatorPublicState>(EMPTY_STATE);
  const [loading, setLoading] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const [healthError, setHealthError] = useState<string>();
  const [operation, setOperation] = useState<OperatorOperation>();
  const [pendingAction, setPendingAction] = useState<OperatorAction>();
  const [yieldAmount, setYieldAmount] = useState("");
  const [toasts, setToasts] = useState<string[]>([]);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const refreshInFlightRef = useRef<Promise<void> | null>(null);

  const addToast = useCallback((message: string) => {
    setToasts((current) => [...current.slice(-2), message]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item !== message)), 3600);
  }, []);

  useEffect(() => {
    if (!wallet.provider || wallet.status !== "connected" || !wallet.address) {
      setContracts(undefined);
      setState(EMPTY_STATE);
      return;
    }
    setContracts(readContracts(wallet.provider));
  }, [wallet.address, wallet.provider, wallet.status]);

  const refresh = useCallback((force = false): Promise<void> => {
    if (!wallet.provider || wallet.status !== "connected" || !contracts) return Promise.resolve();
    const previous = refreshInFlightRef.current;
    if (previous && !force) return previous;
    const request = (async () => {
      if (previous && force) await previous;
      setLoading(true);
      try {
        setRefreshError(undefined);
        const coreState = await loadOperatorCoreState(contracts);
        setState(coreState);
        try {
          const healthState = await loadOperatorHealthState(contracts, wallet.provider!, coreState);
          setState((current) => ({ ...current, ...healthState }));
          setHealthError(undefined);
        } catch (error) {
          setHealthError(`Some protocol health metrics are temporarily unavailable. ${safeErrorDetails(error)}`);
        }
      } catch (error) {
        setState(EMPTY_STATE);
        setHealthError(undefined);
        setRefreshError(`${operationError("Operator state refresh", error)} · ${safeErrorDetails(error)}`);
      } finally {
        setLoading(false);
      }
    })();
    refreshInFlightRef.current = request;
    request.then(() => { if (refreshInFlightRef.current === request) refreshInFlightRef.current = null; }, () => { if (refreshInFlightRef.current === request) refreshInFlightRef.current = null; });
    return request;
  }, [contracts, wallet.provider, wallet.status]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const update = () => setNowSeconds(Math.floor(Date.now() / 1000));
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const operatorAddress = state.engineOperator ?? contractConfig.operatorAddress;
  const access = operatorAccessState({
    walletStatus: wallet.status,
    connectedAddress: wallet.address,
    operatorAddress,
    hasOperatorConfiguration: Boolean(contractsConfigured && contractConfig.prizeEngine),
  });
  const currentState = stateLabel(state.roundState);
  const currentRoundEvidence = useCurrentRoundDepositEvidence(wallet.provider, contractConfig.prizeEngine, contractConfig.veilPool, state.roundId, state.roundState);
  const thresholdReached = currentRoundEvidence.status === "verified" && currentRoundEvidence.depositors.length >= 2;
  const publicSchedule = usePublicRoundSchedule(state.roundId, state.roundState, nowSeconds, roundSchedule, thresholdReached, currentRoundEvidence.thresholdTimestamp);
  const roundMonitor = useMemo(() => roundMonitorView(state.roundId, state.roundState, nowSeconds, publicSchedule, currentRoundEvidence.status === "verified" ? currentRoundEvidence.depositors.length : undefined), [currentRoundEvidence.depositors.length, currentRoundEvidence.status, nowSeconds, publicSchedule, state.roundId, state.roundState]);
  const actions = useMemo(() => access === "authorized" ? availableOperatorActions({
    state: currentState,
    participantCount: state.participantCount,
    publicTotalWeight: state.publicTotalWeight,
    unallocatedHarvestedYield: state.unallocatedHarvestedYield,
    prizeCommitted: state.prizeCommitted,
    acceptanceDecryptionRequested: state.acceptanceDecryptionRequested,
    adapterConfigured: Boolean(state.adapterAddress && state.adapterAddress !== ZERO_ADDRESS),
    principalSyncPending: state.principalSyncPending,
    principalUnwrapPending: state.principalUnwrapPending,
    principalDeployed: state.principalDeployed,
  }) .filter((action) => action !== "lock_round" || thresholdReached) : [], [access, currentState, state, thresholdReached]);

  const runAction = async (action: OperatorAction) => {
    if (!contracts?.engine || !wallet.signer || !wallet.ethereum || access !== "authorized") return;
    const copy = ACTION_COPY[action];
    const readEngine = contracts.engine;
    const writeEngine = contracts.engine.connect(wallet.signer) as NonNullable<ReadContracts["engine"]>;
    const setWalletWaiting = () => setOperation({ action, label: "Waiting for wallet confirmation", status: "waiting_wallet" });
    try {
      setOperation({ action, label: "Preparing action", status: "preparing" });
      let tx: TransactionResponse;
      switch (action) {
        case "request_principal_deployment":
          setWalletWaiting();
          tx = await writeEngine.requestPrincipalDeployment();
          break;
        case "finalize_principal_deployment": {
          const handle = String(await readEngine.confidentialPendingPrincipalLiability());
          const decrypted = await publicDecryptHandle(wallet.ethereum, handle);
          if (typeof decrypted.value !== "bigint") throw new Error("Principal proof returned an unsupported value.");
          setWalletWaiting();
          tx = await writeEngine.finalizePrincipalDeployment(decrypted.value, decrypted.decryptionProof);
          break;
        }
        case "finalize_principal_unwrap": {
          if (!state.pendingPrincipalUnwrapRequest || state.pendingPrincipalUnwrapRequest === ZERO_ADDRESS) throw new Error("No pending principal unwrap request is available.");
          const decrypted = await publicDecryptHandle(wallet.ethereum, state.pendingPrincipalUnwrapRequest);
          if (typeof decrypted.value !== "bigint") throw new Error("Principal unwrap proof returned an unsupported value.");
          setWalletWaiting();
          tx = await writeEngine.finalizePrincipalUnwrap(state.pendingPrincipalUnwrapRequest, decrypted.value, decrypted.decryptionProof);
          break;
        }
        case "restore_principal_liquidity":
          setWalletWaiting();
          tx = await writeEngine.restorePrincipalLiquidity();
          break;
        case "harvest_yield":
          setWalletWaiting();
          tx = await writeEngine.harvestYield();
          break;
        case "lock_round":
          setWalletWaiting();
          tx = await writeEngine.lockRound();
          break;
        case "request_aggregate_decryption":
          setWalletWaiting();
          tx = await writeEngine.requestAggregateDecryption();
          break;
        case "finalize_aggregate_reveal": {
          const handle = String(await readEngine.confidentialTotalWeight());
          const decrypted = await publicDecryptHandle(wallet.ethereum, handle);
          if (typeof decrypted.value !== "bigint") throw new Error("Aggregate proof returned an unsupported value.");
          setWalletWaiting();
          tx = await writeEngine.finalizeAggregateReveal(decrypted.value, decrypted.decryptionProof);
          break;
        }
        case "commit_harvested_yield": {
          if (!yieldAmount.trim()) throw new Error("Enter a harvested yield amount to commit.");
          const amount = parseUnits(yieldAmount.trim(), state.tokenDecimals);
          if (amount <= 0n || amount > state.unallocatedHarvestedYield) throw new Error("Commit an amount within the available harvested yield.");
          setWalletWaiting();
          tx = await writeEngine.commitHarvestedYield(amount);
          break;
        }
        case "close_empty_round":
          setWalletWaiting();
          tx = await writeEngine.closeEmptyRound();
          break;
        case "cancel_no_yield_round":
          setWalletWaiting();
          tx = await writeEngine.cancelNoYieldRound();
          break;
        case "execute_draw":
          setWalletWaiting();
          tx = await writeEngine.executeDraw();
          break;
        case "request_draw_acceptance":
          setWalletWaiting();
          tx = await writeEngine.requestDrawAcceptance();
          break;
        case "finalize_draw_acceptance": {
          const handle = String(await readEngine.confidentialHasAccepted());
          const decrypted = await publicDecryptHandle(wallet.ethereum, handle);
          if (typeof decrypted.value !== "boolean") throw new Error("Draw acceptance proof returned an unsupported value.");
          setWalletWaiting();
          tx = await writeEngine.finalizeDrawAcceptance(decrypted.value, decrypted.decryptionProof);
          break;
        }
        case "start_next_round":
          setWalletWaiting();
          tx = await writeEngine.startNextRound();
          break;
      }
      setOperation({ action, label: "Transaction submitted", status: "submitted", txHash: tx.hash });
      setOperation({ action, label: "Waiting for confirmation", status: "confirming", txHash: tx.hash });
      const hash = await waitForTransaction(tx);
      setOperation({ action, label: "Complete", status: "complete", txHash: hash });
      setPendingAction(undefined);
      addToast(copy.toast);
      await refresh(true);
    } catch (error) {
      setPendingAction(undefined);
      const message = `${operationError("Operator action", error)} · ${safeErrorDetails(error)}`;
      setOperation({ action, label: "Action failed", status: "failed", error: message });
      setRefreshError(message);
    }
  };

  const requestAction = (action: OperatorAction) => {
    if (CONFIRM_ACTIONS.has(action)) setPendingAction(action);
    else void runAction(action);
  };

  const heroMotion = reduced ? false : { opacity: 0, scale: 1.04 };
  const heroAnimate = { opacity: 1, scale: 1 };

  return <div className="operator-page">
    <header className="operator-header"><div className="operator-header__inner"><VeilPoolLogo /><span className="operator-header__title">Operator</span><div className="operator-header__actions"><NetworkStatus wallet={wallet} onSwitch={() => void switchToSepolia().catch(() => undefined)} /><ThemeToggle />{wallet.address ? <ConnectedWalletMenu address={wallet.address} displayAddress={formatAddress(wallet.address)} onDisconnect={resetWallet} /> : <Button onClick={() => void connect()} className="operator-connect">Connect wallet <ArrowUpRight size={15} /></Button>}<a className="operator-dashboard-link" href="/app">Back to dashboard <ArrowRight size={14} /></a></div></div></header>
    <main className="operator-main">
      <div className="operator-breadcrumb"><a href="/app"><ArrowLeft size={14} /> Back to dashboard</a><span>VeilPool / Protocol operations</span></div>
      {wallet.status === "unsupported" && <div className="operator-alert" role="alert"><WalletCards size={18} /><div><strong>Wallet unavailable</strong><p>Connect a compatible EVM wallet that supports EIP-1193 to use the operator panel.</p></div></div>}
      {wallet.status === "error" && wallet.error && <div className="operator-alert" role="alert"><CircleAlert size={18} /><div><strong>Wallet error</strong><p>{wallet.error}</p></div></div>}
      {refreshError && <div className="operator-alert" role="alert"><CircleAlert size={18} /><div><strong>Protocol state unavailable</strong><p>{refreshError}</p></div><button aria-label="Dismiss error" onClick={() => setRefreshError(undefined)}><X size={16} /></button></div>}
      {healthError && <div className="operator-alert" role="status"><CircleAlert size={18} /><div><strong>Some protocol health metrics are temporarily unavailable.</strong><p>{healthError.replace("Some protocol health metrics are temporarily unavailable. ", "")}</p></div><button aria-label="Dismiss health warning" onClick={() => setHealthError(undefined)}><X size={16} /></button></div>}
      <AccessState access={access} onConnect={() => void connect()} onSwitch={() => void switchToSepolia().catch(() => undefined)} />
      {access === "authorized" && <>
        <section className="operator-hero dark-media-surface"><motion.img className="operator-hero__image" src={OPERATOR_ASSET} alt="" aria-hidden="true" initial={heroMotion} animate={heroAnimate} transition={{ duration: .9, ease: "easeOut" }} /><div className="operator-hero__veil" aria-hidden="true" /><div className="operator-hero__content"><div><span className="operator-kicker">Authorized operator</span><h1>Protocol control<br /><em>without private access.</em></h1><p>Operate rounds, yield, and settlement without seeing individual savings, eligibility, or winnings.</p></div><div className="operator-assurance"><div><strong><Check size={15} /> Operator can</strong><span>Advance round lifecycle</span><span>Process public protocol state</span><span>Trigger legitimate draw actions</span></div><div><strong><X size={15} /> Operator cannot</strong><span>View individual balances</span><span>View private eligibility</span><span>Choose the winner</span></div></div></div></section>
        <section className="operator-overview"><div className="operator-section-heading"><span className="operator-kicker">Protocol overview</span><h2>Public state,<br /><em>precisely accounted.</em></h2></div><button className="operator-refresh" onClick={() => void refresh()} disabled={loading} aria-label="Refresh operator state"><RefreshCw size={15} className={loading ? "is-spinning" : ""} /> {loading ? "Refreshing" : "Refresh state"}</button><div className="operator-metrics"><div><span>Current round</span><strong>{state.roundId === undefined ? "Unavailable" : `#${state.roundId}`}</strong></div><div><span>Lifecycle status</span><strong>{currentState.replaceAll("_", " ")}</strong></div><div><span>Participants</span><strong>{state.participantCount.toString()} <small>/ {state.maxParticipants.toString()}</small></strong></div><div><span>Aggregate total</span><strong>{state.publicTotalWeight === undefined ? "Encrypted" : state.publicTotalWeight.toString()}</strong></div><div><span>Prize source</span><strong>{state.roundPrizeAmount !== undefined ? publicAmount(state.roundPrizeAmount, state.tokenDecimals) : "Separate yield"}</strong></div><div><span>Principal state</span><strong>{state.principalUnwrapPending ? "Restoring" : state.principalSyncPending ? "Sync requested" : "No pending sync"}</strong></div></div><ScheduleNotice view={roundMonitor} /></section>
        <div className="operator-workbench"><Lifecycle current={currentState} /><section className="operator-actions"><div className="operator-section-heading"><span className="operator-kicker">State-aware controls</span><h2>Advance only<br /><em>valid protocol actions.</em></h2></div>{state.roundState === undefined && <p className="operator-muted">Connect a configured deployment to read available actions.</p>}{state.roundState !== undefined && actions.length === 0 && <p className="operator-muted">No operator action is currently valid for {currentState.replaceAll("_", " ")}.</p>}<div className="operator-action-list">{actions.map((action) => { const title = action === "start_next_round" && state.roundId !== undefined ? `Start Round #${state.roundId + 1n}` : ACTION_COPY[action].title; const emphasized = action === "lock_round" || action === "execute_draw" || (action === "start_next_round" && roundMonitor.scheduleHeading === "ROUND READY"); return <div className="operator-action" key={action}><div><strong>{title}</strong><p>{ACTION_COPY[action].description}</p>{action === "commit_harvested_yield" && <label className="operator-yield-input"><span>Amount to commit</span><input inputMode="decimal" value={yieldAmount} onChange={(event) => setYieldAmount(event.target.value)} placeholder={formatUnits(state.unallocatedHarvestedYield, state.tokenDecimals)} /><small>Available: {formatUnits(state.unallocatedHarvestedYield, state.tokenDecimals)} vPOOL</small></label>}</div><Button variant={emphasized ? "primary" : "secondary"} onClick={() => requestAction(action)} disabled={Boolean(operation && (operation.status === "preparing" || operation.status === "waiting_wallet" || operation.status === "submitted" || operation.status === "confirming")) || (action === "commit_harvested_yield" && !yieldAmount.trim())}>{title} <ArrowUpRight size={15} /></Button></div>; })}</div>{currentState === "RETRY_REQUIRED" && <div className="operator-retry"><strong>Fresh encrypted randomness required.</strong><p>The previous bounded batch produced no accepted candidate. Retry runs a fresh encrypted batch without revealing rejected candidates or a public retry count.</p></div>}{currentState === "DRAW_READY" && state.publicTotalWeight === 0n && <div className="operator-retry"><strong>No eligible balance exists for this round.</strong><p>Close the verified empty round without creating a prize.</p></div>}</section></div>
        <section className="operator-health"><div className="operator-section-heading"><span className="operator-kicker">Protocol health</span><h2>Separate principal<br /><em>from prize.</em></h2></div><div className="operator-health__grid"><div><span>Principal backing</span><strong>{state.adapterAddress && state.healthAvailable ? `${publicAmount(state.principalDeployed, state.tokenDecimals)} deployed` : "Unavailable"}</strong><small>{state.adapterAddress && state.healthAvailable ? `${publicAmount(state.managedAssets, state.tokenDecimals)} managed in adapter` : "Some protocol health metrics are temporarily unavailable."}</small></div><div><span>Generated yield</span><strong>{state.adapterAddress && state.healthAvailable ? publicAmount(state.generatedYield, state.tokenDecimals) : "Unavailable"}</strong><small>Only surplus may become a prize source.</small></div><div><span>Yield source</span><strong>Controlled Sepolia simulation</strong><small>Test assets only; not external DeFi yield.</small></div><div><span>Yield adapter</span><strong>{state.adapterAddress ? "Configured" : "Unavailable"}</strong><small>Controller and asset checks remain on-chain.</small></div><div><span>Participant limit</span><strong>{state.participantCount <= state.maxParticipants ? "Healthy" : "Action required"}</strong><small>{state.participantCount.toString()} of {state.maxParticipants.toString()} registered.</small></div></div><div className="operator-invariant"><span>Accounting invariant</span><strong>PRINCIPAL <em>≠</em> PRIZE</strong></div></section>
        <PrivacyBoundary />
      </>}
    </main>
    <footer className="operator-footer"><VeilPoolLogo compact /><span>VeilPool · Phase 6C operator panel · no private user data</span><a href="https://sepolia.etherscan.io" target="_blank" rel="noreferrer">Sepolia Explorer <ExternalLink size={12} /></a></footer>
    {operation && <div className="operator-operation" role="status" aria-live="polite"><div><span className="operator-kicker">Operator transaction</span><strong>{operation.label}</strong>{operation.error && <small>{operation.error}</small>}{operation.txHash && <a href={explorerTxUrl(operation.txHash)} target="_blank" rel="noreferrer">View transaction <ExternalLink size={12} /></a>}</div>{operation.status !== "complete" && operation.status !== "failed" && <VeilPoolLoader variant="inline" statusText={operation.label} />}{operation.status === "complete" && <Check size={18} />}</div>}
    <Toasts toasts={toasts} />
    {pendingAction && <ConfirmDialog action={pendingAction} onCancel={() => setPendingAction(undefined)} onConfirm={() => void runAction(pendingAction)} />}
    <WalletSelector open={walletSelectionOpen} wallets={walletOptions} onClose={closeWalletSelection} onSelect={(walletId) => void connect(walletId)} />
  </div>;
}
