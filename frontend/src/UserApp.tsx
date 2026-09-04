import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, parseUnits, type Contract } from "ethers";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  Eye,
  EyeOff,
  ExternalLink,
  LockKeyhole,
  LoaderCircle,
  Network,
  RefreshCw,
  ShieldCheck,
  WalletCards,
  X,
} from "lucide-react";
import { Button, ConnectedWalletMenu, ThemeToggle, VeilPoolLoader, VeilPoolLogo, WalletSelector, WithdrawalProgress } from "./components";
import "./user-app.css";
import { canBeginOperation, formatAddress, operationButtonState, operationCopy, operationError, operationUiState, prizeWithdrawalComingSoonNotice, roundStateDescription, roundStateLabel, safeErrorDetails, shouldShowSettledWinningsMessage, settledWinningsMessage, validateAmount } from "./appLogic";
import { contractsConfigured, contractConfig, explorerTxUrl, missingCoreContracts, roundSchedule } from "./config/contracts";
import { depositInputBinding } from "./lib/fheInputBinding";
import { canStartFaucetMint, faucetAvailability, mintTestTokens, type MintableToken } from "./lib/testTokenFaucet";
import { balanceStatusText, readUnderlyingBalance, type BalanceReadStatus } from "./lib/underlyingBalance";
import { decryptHandle, encryptUint64, publicDecryptHandle, readContracts, type ReadContracts, waitForTransaction } from "./lib/veilpoolClient";
import { canOfferRecovery, canOfferResume, canResumeWithBalance, createWalletSessionGuard, hasConfidentialBalance, requiredWrapAmount, sameWalletSession, UNWRAP_PROGRESS_STEPS, unwrapProgressCopy, unwrapProgressStep, unwrapSuccessCopy, wrapperBalancePresentation, wrapperStateSessionKey, type UnwrapProgressStatus, type WalletSessionGuard, type WalletSessionToken } from "./lib/depositRecovery";
import { depositEmptyStateMessage, depositParticipationCopy, formatRoundClockCountdown, roundMonitorView, type RoundMonitorView, usePublicRoundSchedule } from "./lib/roundMonitor";
import { useCurrentRoundDepositEvidence } from "./lib/roundParticipants";
import { displayErrorMessage, useWallet, type WalletState } from "./wallet";

type ModalKind = "deposit" | "withdraw" | null;
type RevealKind = "savings" | "winnings";
type RevealStatus = "idle" | "requesting" | "decrypting" | "revealed" | "failed";
type OperationKind = "deposit" | "withdraw";

const DASHBOARD_ASSETS = {
  user: "/images/dashboard-user.png",
  yield: "/images/dashboard-yield.png",
} as const;

type PublicState = {
  underlyingBalance: bigint;
  underlyingDecimals: number;
  isParticipant: boolean;
  participantCount: bigint;
  maxParticipants: bigint;
  savingsHandle?: string;
  winningsHandle?: string;
  eligibilityHandle?: string;
  wrappedBalanceHandle?: string;
  roundId?: bigint;
  roundState?: bigint;
  publicTotalWeight?: bigint;
  roundPrizeAmount?: bigint;
  unallocatedHarvestedYield?: bigint;
  principalLiability?: bigint;
  principalSyncPending: boolean;
  principalUnwrapPending: boolean;
};

type OperationState = {
  kind: OperationKind;
  step: number;
  label: string;
  waitingForWallet: boolean;
  error?: string;
  txHash?: string;
  starting?: boolean;
};

type WrappedBalanceState = {
  status: "idle" | "requesting" | "revealed" | "failed";
  value?: bigint;
  error?: string;
};

type RecoveryState = {
  status: UnwrapProgressStatus;
  step?: number;
  requestId?: string;
  txHash?: string;
  amount?: bigint;
  waitingForWallet?: boolean;
  error?: string;
};

type InFlightRefresh = {
  session: WalletSessionToken;
  promise: Promise<{ balanceLoaded: boolean }>;
};

const EMPTY_PUBLIC_STATE: PublicState = {
  underlyingBalance: 0n,
  underlyingDecimals: 6,
  isParticipant: false,
  participantCount: 0n,
  maxParticipants: 10n,
  principalSyncPending: false,
  principalUnwrapPending: false,
};

const OPERATOR_EXPIRY_DAYS = 30;

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function safeBigInt(value: unknown): bigint {
  return BigInt(String(value));
}

function trimUnits(value: bigint, decimals: number): string {
  return formatUnits(value, decimals).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function displayRoundState(value?: bigint): string {
  return value === undefined ? "Unavailable" : roundStateLabel(value);
}

function readConfiguredUnderlyingBalance(contracts: ReadContracts, address: string) {
  return readUnderlyingBalance({
    balanceOf: (account) => contracts.underlying.balanceOf(account),
    decimals: () => contracts.underlying.decimals(),
  }, address, contractConfig.underlyingToken);
}

async function loadPublicState(contracts: ReadContracts, address?: string, underlyingOverride?: { value: bigint; decimals: number }): Promise<PublicState> {
  if (!address) return EMPTY_PUBLIC_STATE;
  const underlying = underlyingOverride || await readConfiguredUnderlyingBalance(contracts, address);
  const [isParticipant, participantCount, maxParticipants, wrappedBalanceHandle] = await Promise.all([
    contracts.vault.isParticipant(address),
    contracts.vault.participantCount(),
    contracts.vault.maxParticipants(),
    contracts.token.confidentialBalanceOf(address),
  ]);
  const state: PublicState = {
    underlyingBalance: underlying.value,
    underlyingDecimals: underlying.decimals,
    isParticipant: Boolean(isParticipant),
    participantCount: safeBigInt(participantCount),
    maxParticipants: safeBigInt(maxParticipants),
    wrappedBalanceHandle: String(wrappedBalanceHandle),
    principalSyncPending: false,
    principalUnwrapPending: false,
  };
  if (state.isParticipant) {
    const [savingsHandle, winningsHandle, eligibilityHandle] = await Promise.all([
      contracts.vault.confidentialBalanceOf(address),
      contracts.vault.confidentialWinningsOf(address),
      contracts.vault.confidentialEligibilityOf(address),
    ]);
    state.savingsHandle = String(savingsHandle);
    state.winningsHandle = String(winningsHandle);
    state.eligibilityHandle = String(eligibilityHandle);
  }
  if (contracts.engine) {
    const [roundId, roundState, publicTotalWeight, roundPrizeAmount, unallocatedHarvestedYield, principalLiabilityRevealRequested, principalUnwrapPending, publicPrincipalLiability] = await Promise.all([
      contracts.engine.roundId(),
      contracts.engine.roundState(),
      contracts.engine.publicTotalWeight(),
      contracts.engine.roundPrizeAmount(),
      contracts.engine.unallocatedHarvestedYield(),
      contracts.engine.principalLiabilityRevealRequested(),
      contracts.engine.principalUnwrapPending(),
      contracts.engine.publicPrincipalLiability(),
    ]);
    state.roundId = safeBigInt(roundId);
    state.roundState = safeBigInt(roundState);
    state.publicTotalWeight = safeBigInt(publicTotalWeight);
    state.roundPrizeAmount = safeBigInt(roundPrizeAmount);
    state.unallocatedHarvestedYield = safeBigInt(unallocatedHarvestedYield);
    state.principalSyncPending = Boolean(principalLiabilityRevealRequested);
    state.principalUnwrapPending = Boolean(principalUnwrapPending);
    state.principalLiability = safeBigInt(publicPrincipalLiability);
  }
  return state;
}

function NetworkStatus({ wallet, onSwitch }: { wallet: WalletState; onSwitch: () => void }) {
  if (wallet.status === "wrong-network") return <button className="app-network app-network--warning" onClick={onSwitch}><Network size={14} /> Wrong network · Switch to Sepolia</button>;
  if (wallet.status === "connected") return <span className="app-network app-network--ready"><span className="app-status-dot" /> Sepolia</span>;
  return <span className="app-network"><Network size={14} /> Sepolia</span>;
}

function ConfigBanner() {
  return <div className="app-banner app-banner--config" role="status"><CircleHelp size={18} /><div><strong>Contracts not configured</strong><p>VeilPool contracts are not configured for this environment. The dashboard shell is reviewable; add Sepolia addresses in <code>frontend/.env</code> to enable blockchain actions.</p><span>Missing: {missingCoreContracts.join(", ")}{contractConfig.prizeEngine ? "" : " · PrizeEngine (optional for round state)"}</span></div></div>;
}

function ErrorBanner({ message, details, onDismiss }: { message: string; details?: string; onDismiss: () => void }) {
  return <div className="app-banner app-banner--error" role="alert"><CircleAlert size={18} /><div><strong>Action unavailable</strong><p>{message}</p><details><summary>Technical details</summary><small>{details || "Review the wallet network, contract configuration, and provider state before retrying."}</small></details></div><button aria-label="Dismiss error" onClick={onDismiss}><X size={16} /></button></div>;
}

function Toasts({ toasts }: { toasts: string[] }) {
  return <div className="app-toasts" aria-live="polite" aria-atomic="true">{toasts.map((toast, index) => <motion.div className="app-toast" key={`${toast}-${index}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}><Check size={15} /> {toast}</motion.div>)}</div>;
}

function RevealValue({ kind, status, value, decimals, onReveal, onHide }: { kind: RevealKind; status: RevealStatus; value?: bigint; decimals: number; onReveal: () => void; onHide: () => void }) {
  const label = kind === "savings" ? "Your private savings" : "Your winnings";
  const hasValue = value !== undefined && status === "revealed";
  return <div className="app-private-card__value-row"><div><span className="app-data-label">{label}</span><strong className={hasValue ? "app-private-card__amount app-private-card__amount--revealed" : "app-private-card__amount"}>{hasValue ? `${trimUnits(value, decimals)} mUNDER` : "••••••••"}</strong></div><button className="app-reveal" onClick={hasValue ? onHide : onReveal} disabled={status === "requesting" || status === "decrypting"}>{status === "requesting" ? <VeilPoolLoader variant="inline" statusText="Requesting authorization…" /> : status === "decrypting" ? <VeilPoolLoader variant="inline" statusText="Decrypting…" /> : hasValue ? <><EyeOff size={14} /> Hide</> : <><Eye size={14} /> Reveal</>}</button></div>;
}

function SettledWinningsResult({ value, decimals, reduced }: { value: bigint; decimals: number; reduced: boolean | null }) {
  const message = settledWinningsMessage(value, decimals);
  return <><motion.div className={`app-settled-result app-settled-result--${message.tone}`} role="status" aria-live="polite" initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .35, ease: "easeOut" }}><span className="app-settled-result__mark" aria-hidden="true">{message.tone === "won" ? "✦" : "✓"}</span><div><strong>{message.title}</strong><span>{message.body}</span></div></motion.div><div className="app-winnings-notice" role="note"><strong>{prizeWithdrawalComingSoonNotice.title}</strong><span>{prizeWithdrawalComingSoonNotice.body}</span></div></>;
}

function WrappedBalanceNotice({
  handle,
  status,
  value,
  decimals,
  requestedUnits,
  recovery,
  error,
  onReveal,
  onResume,
  onRecover,
  onDismissRecovery,
}: {
  handle?: string;
  status: WrappedBalanceState["status"];
  value?: bigint;
  decimals: number;
  requestedUnits?: bigint;
  recovery: RecoveryState;
  error?: string;
  onReveal: () => void;
  onResume: () => void;
  onRecover: () => void;
  onDismissRecovery: () => void;
}) {
  const recoveryActive = recovery.status !== "idle" && recovery.status !== "complete" && !(recovery.status === "failed" && !recovery.requestId);
  const recoveryComplete = recovery.status === "complete";
  if (!hasConfidentialBalance(handle) && !recoveryComplete) return null;
  const presentation = recoveryComplete ? unwrapSuccessCopy(recovery.amount, decimals) : wrapperBalancePresentation(status, value, decimals);
  const canResume = canOfferResume(status, requestedUnits, value);
  const canRecover = canOfferRecovery(status, value);
  const recoveryBusy = recoveryActive;
  const progressCopy = unwrapProgressCopy(recovery.status);
  const canStartRecovery = canRecover && !recovery.txHash;
  const showRepeat = recoveryComplete && canRecover;
  return <aside className="app-wrapped-balance" role="status">
    <div className="app-wrapped-balance__copy"><span className="app-kicker">Confidential wrapper balance</span><strong>{presentation.title}</strong><span>{presentation.detail}</span>{recoveryComplete && value === 0n && <small>No unused confidential balance.</small>}{status === "failed" && <small role="alert">{error || "Confidential balance review failed. No new wrap was attempted."}</small>}{recovery.status === "failed" && !recovery.requestId && recovery.error && <small role="alert">{recovery.error}</small>}{recovery.status === "failed" && recovery.requestId && <small role="alert">The unwrap request exists, but finalization still needs to complete. Retry when the FHE service is available.</small>}</div>
    {recoveryActive && <div className="app-recovery-progress"><WithdrawalProgress currentStep={unwrapProgressStep(recovery.status, recovery.step)} steps={[...UNWRAP_PROGRESS_STEPS]} label="Unwrap" /><p className="app-operation__status">{progressCopy.label}</p>{progressCopy.supporting && <p className="app-recovery-progress__supporting">{progressCopy.supporting}</p>}{recovery.error && <p className="app-validation" role="alert">{recovery.error}</p>}</div>}
    <div className="app-wrapped-balance__actions">
      {status !== "revealed" && !recoveryBusy && !recoveryComplete && <Button variant="secondary" onClick={onReveal} disabled={status === "requesting"}>{status === "requesting" ? "Reviewing…" : "Review confidential balance"}</Button>}
      {canResume && !recoveryBusy && <Button onClick={onResume}>Resume private deposit <ArrowUpRight size={15} /></Button>}
      {canStartRecovery && !recoveryBusy && !recoveryComplete && <Button variant="secondary" onClick={onRecover}>Unwrap to public mUNDER <ArrowUpRight size={15} /></Button>}
      {recovery.status === "failed" && recovery.requestId && <Button variant="secondary" onClick={onRecover}>Retry recovery finalization <RefreshCw size={14} /></Button>}
      {showRepeat && <Button variant="secondary" onClick={onRecover}>Unwrap again <ArrowUpRight size={15} /></Button>}
      {recoveryComplete && <Button variant="secondary" onClick={onDismissRecovery}>Done</Button>}
    </div>
  </aside>;
}

function RoundMonitor({ view }: { view: RoundMonitorView }) {
  const lifecycle = [
    ["OPEN", "Deposits"],
    ["LOCKED", "Snapshot"],
    ["DRAW", "Selection"],
    ["SETTLED", "Complete"],
  ] as const;
  return <div className={`app-round-monitor app-round-monitor--${view.mode}`} aria-label="Round monitor"><div className="app-round-monitor__top"><div><span className="app-kicker">Round monitor</span><strong>{view.title}</strong></div><span className="app-round-monitor__status">{view.status}</span></div>{view.scheduleHeading && <div className="app-round-monitor__schedule"><span>{view.scheduleHeading}</span>{view.scheduleTitle && <strong>{view.scheduleTitle}</strong>}{view.countdownSeconds !== undefined && <><strong className="app-round-monitor__countdown-value">{formatRoundClockCountdown(view.countdownSeconds)}</strong><div className="app-round-monitor__time-units" aria-hidden="true"><span>HRS</span><span>MIN</span><span>SEC</span></div></>}<p>{view.scheduleSupporting}</p></div>}<p>{view.supporting}</p><div className="app-round-monitor__lifecycle" aria-label="Round lifecycle">{lifecycle.map(([label, description], index) => <div className={index <= ["open", "locked", "draw", "settled"].indexOf(view.lifecycleStage) ? "is-reached" : ""} key={label}><span>{label}</span><small>{description}</small></div>)}</div></div>;
}

function FundedRoundOverlay({ view, reduced, onDismiss }: { view: RoundMonitorView; reduced: boolean | null; onDismiss: () => void }) {
  if (view.countdownSeconds === undefined || !view.roundLabel || !view.scheduleHeading || view.lifecycleStage !== "open") return null;
  return <div className="app-funded-overlay" role="dialog" aria-modal="true" aria-labelledby="funded-round-title"><motion.div className="app-funded-overlay__panel" initial={reduced ? false : { opacity: 0, scale: .97, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: .3, ease: "easeOut" }}><span className="app-kicker">{view.roundLabel.toUpperCase()} IS FUNDED</span><h2 id="funded-round-title">Two private participants confirmed</h2><span className="app-funded-overlay__label">Deposits close in</span><strong className="app-funded-overlay__countdown">{formatRoundClockCountdown(view.countdownSeconds)}</strong><div className="app-funded-overlay__units"><span>HRS</span><span>MIN</span><span>SEC</span></div><p>The encrypted draw becomes ready after the deposit window.</p><Button variant="secondary" onClick={onDismiss}>Continue to dashboard <ArrowUpRight size={15} /></Button></motion.div></div>;
}

function Modal({ kind, amount, setAmount, state, decimals, available, balanceStatus, balanceError, onClose, onSubmit, onRepeat }: { kind: Exclude<ModalKind, null>; amount: string; setAmount: (value: string) => void; state?: OperationState; decimals: number; available?: bigint; balanceStatus: BalanceReadStatus; balanceError?: string; onClose: () => void; onSubmit: () => void; onRepeat: () => void }) {
  const isDeposit = kind === "deposit";
  const copy = operationCopy(kind);
  const buttonState = operationButtonState(kind, state);
  const uiState = operationUiState(state);
  const validation = validateAmount(amount, isDeposit && balanceStatus !== "loaded" ? undefined : available, decimals);
  const busy = buttonState.disabled;
  const complete = uiState === "complete";
  const steps = isDeposit ? ["Check confidential balance", "Approve required amount", "Wrap required amount", "Authorize VeilPool", "Prepare encrypted deposit", "Submit deposit", "Wait for confirmation"] : ["Preparing withdrawal", "Encrypting amount", "Submitting withdrawal", "Waiting for confirmation"];
  const activeStep = state ? Math.min(state.step, steps.length - 1) : 0;
  const balanceCopy = balanceStatus === "error" ? `${balanceError || "Balance read failed."} Retry before depositing.` : balanceStatusText(balanceStatus, available, decimals);
  return <div className="app-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="app-modal" role="dialog" aria-modal="true" aria-labelledby="app-modal-title"><div className="app-modal__header"><div><span className="app-kicker">Private action</span><h2 id="app-modal-title">{complete ? copy.successStatus : isDeposit ? "Deposit privately" : "Withdraw privately"}</h2></div><button aria-label="Close dialog" onClick={onClose} disabled={busy}><X size={18} /></button></div>{isDeposit ? <p className="app-modal__copy">Convert your public Sepolia test asset into confidential VeilPool savings. Approval, wrapping, authorization, and deposit are shown as separate wallet steps.</p> : <p className="app-modal__copy">This confidential withdrawal returns vPOOL from VeilPool to your wallet. Underlying principal restoration remains a separate protocol-operator process.</p>}{complete && <p className="app-modal__success" role="status">{copy.successStatus}. Your private flow is confirmed.</p>}<label className="app-field"><span>Amount</span><div className="app-field__input"><input autoFocus inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" aria-describedby="amount-help" disabled={busy || complete} /><span>mUNDER</span></div></label>{isDeposit ? <p id="amount-help" className={`app-field-help app-field-help--${balanceStatus}`}>Available test balance: <strong>{balanceCopy}</strong></p> : <p id="amount-help" className="app-field-help">Revealed savings available: <strong>{available === undefined ? "Reveal your savings first" : `${trimUnits(available, decimals)} mUNDER`}</strong></p>}{validation && !complete && <p className="app-validation" role="alert">{validation}</p>}{state && <div className="app-operation"><WithdrawalProgress currentStep={activeStep} steps={steps} label={isDeposit ? "Deposit" : "Withdrawal"} /><p className="app-operation__status">{state.waitingForWallet ? "Waiting for you in your wallet" : complete ? copy.successStatus : state.label}</p>{state.error && <p className="app-validation" role="alert">{state.error}</p>}{state.txHash && <a href={explorerTxUrl(state.txHash)} target="_blank" rel="noreferrer">View on Sepolia Explorer <ExternalLink size={13} /></a>}</div>}<div className="app-modal__actions">{!complete && <Button onClick={onSubmit} className="app-modal__submit" disabled={buttonState.disabled || Boolean(validation) || !amount.trim() || (isDeposit && balanceStatus !== "loaded")} aria-busy={buttonState.loading}>{buttonState.loading && <LoaderCircle className="app-operation-spinner" size={15} aria-hidden="true" />}{buttonState.label}{!buttonState.loading && <ArrowUpRight size={15} />}</Button>}{complete && <Button onClick={onRepeat} className="app-modal__submit">{copy.successAction} <ArrowUpRight size={15} /></Button>}{complete && <Button variant="secondary" onClick={onClose}>Done</Button>}</div></section></div>;
}

function VerificationPanel({ state }: { state: PublicState }) {
  const [open, setOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const roundState = displayRoundState(state.roundState);
  return <section className="app-verification"><button className="app-verification__toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}><span><ShieldCheck size={16} /> Round verification</span><ChevronDown size={17} className={open ? "is-open" : ""} /></button>{open && <div className="app-verification__body"><dl><div><dt>Round ID</dt><dd>{state.roundId === undefined ? "Unavailable" : `#${state.roundId}`}</dd></div><div><dt>Status</dt><dd>{roundState}</dd></div><div><dt>Participants</dt><dd>{state.participantCount.toString()} / {state.maxParticipants.toString()}</dd></div><div><dt>Aggregate total</dt><dd>{state.publicTotalWeight === undefined ? "Encrypted / unavailable" : state.publicTotalWeight.toString()}</dd></div><div><dt>Prize source</dt><dd>Generated yield</dd></div><div><dt>Settlement</dt><dd>{state.roundState === 6n ? "Settled" : "Not settled"}</dd></div></dl><p>{roundStateDescription(state.roundState === undefined ? "UNKNOWN" : roundStateLabel(state.roundState))} Public verification excludes individual deposits, eligibility, winnings, and winner identity.</p></div>}<button className="app-verification__how-toggle" onClick={() => setHowOpen((value) => !value)} aria-expanded={howOpen} aria-controls="round-how-works"><span><CircleHelp size={15} /> How rounds work</span><ChevronDown size={16} className={howOpen ? "is-open" : ""} /></button>{howOpen && <div id="round-how-works" className="app-verification__how" role="region" aria-label="How rounds work explanation"><p>Each round is one prize cycle. While a round is open, eligible deposits contribute to the encrypted prize draw. When the round is locked, eligibility is frozen for that round. Generated yield becomes the prize, and the winner is selected using an encrypted, balance-weighted draw.</p><p><strong>Sepolia scheduling:</strong> On this Sepolia deployment, rounds are started and locked by the operator rather than by a fixed timer.</p><p className="app-verification__direction">VeilPool is designed around predictable recurring prize rounds, such as weekly rounds, for a production deployment.</p><div className="app-round-flow" aria-label="Round lifecycle"><div><strong>OPEN</strong><span>Deposits can join.</span></div><div><strong>LOCKED</strong><span>Eligibility freezes.</span></div><div><strong>DRAW</strong><span>Encrypted selection runs.</span></div><div><strong>SETTLED</strong><span>Prize outcome is recorded.</span></div></div><p><strong>Your eligibility:</strong> It is based on your deposited balance when the round is locked. Larger eligible balances have proportionally greater weight in the draw. Individual balances and winner selection remain confidential.</p></div>}</section>;
}

export default function UserApp() {
  const reduced = useReducedMotion();
  const { wallet, walletOptions, walletSelectionOpen, connect, closeWalletSelection, resetWallet, switchToSepolia } = useWallet();
  const [state, setState] = useState<PublicState>(EMPTY_PUBLIC_STATE);
  const [contracts, setContracts] = useState<ReadContracts>();
  const [loading, setLoading] = useState(false);
  const [balanceStatus, setBalanceStatus] = useState<BalanceReadStatus>("idle");
  const [balanceError, setBalanceError] = useState<string>();
  const [modal, setModal] = useState<ModalKind>(null);
  const [amount, setAmount] = useState("");
  const [operation, setOperation] = useState<OperationState>();
  const [error, setError] = useState<string>();
  const [toasts, setToasts] = useState<string[]>([]);
  const [faucetStatus, setFaucetStatus] = useState<"idle" | "minting" | "balance-refreshing" | "balance-loaded" | "balance-read-failed" | "failure">("idle");
  const [faucetError, setFaucetError] = useState<string>();
  const [faucetTxHash, setFaucetTxHash] = useState<string>();
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const [publicEvidenceRefresh, setPublicEvidenceRefresh] = useState(0);
  const [fundedOverlayRound, setFundedOverlayRound] = useState<string>();
  const [reveals, setReveals] = useState<Record<RevealKind, { status: RevealStatus; value?: bigint }>>({ savings: { status: "idle" }, winnings: { status: "idle" } });
  const [wrappedBalance, setWrappedBalance] = useState<WrappedBalanceState>({ status: "idle" });
  const [recovery, setRecovery] = useState<RecoveryState>({ status: "idle" });
  const [partialDepositUnits, setPartialDepositUnits] = useState<bigint>();
  const refreshInFlightRef = useRef<InFlightRefresh | null>(null);
  const operationInFlightRef = useRef(false);
  const wrappedHandleRef = useRef<string | undefined>(undefined);
  const walletSessionKey = wrapperStateSessionKey(wallet.status, wallet.address, wallet.walletId);
  const sessionGuardRef = useRef<WalletSessionGuard | undefined>(undefined);
  if (!sessionGuardRef.current) sessionGuardRef.current = createWalletSessionGuard(walletSessionKey);
  sessionGuardRef.current.update(walletSessionKey);
  const sessionGuard = sessionGuardRef.current;

  const addToast = useCallback((message: string) => {
    setToasts((current) => [...current.slice(-2), message]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item !== message)), 3600);
  }, []);

  const refresh = useCallback((force = false): Promise<{ balanceLoaded: boolean }> => {
    if (!wallet.provider || wallet.status !== "connected" || !contracts || !wallet.address) return Promise.resolve({ balanceLoaded: false });
    const session = sessionGuard.capture();
    const previous = refreshInFlightRef.current;
    if (previous && sameWalletSession(previous.session, session) && !force) return previous.promise;
    if (previous && !sameWalletSession(previous.session, session)) refreshInFlightRef.current = null;
    const request = (async () => {
      if (!sessionGuard.isCurrent(session)) return { balanceLoaded: false };
      if (previous && sameWalletSession(previous.session, session) && force) {
        await previous.promise;
        if (!sessionGuard.isCurrent(session)) return { balanceLoaded: false };
      }
      setLoading(true);
      setBalanceStatus("loading");
      setBalanceError(undefined);
      try {
        const underlying = await readConfiguredUnderlyingBalance(contracts, wallet.address!);
        if (!sessionGuard.isCurrent(session)) return { balanceLoaded: false };
        setState((current) => ({ ...current, underlyingBalance: underlying.value, underlyingDecimals: underlying.decimals }));
        setBalanceStatus("loaded");
        try {
          const protocol = await loadPublicState(contracts, wallet.address, underlying);
          if (!sessionGuard.isCurrent(session)) return { balanceLoaded: false };
          setState(protocol);
        } catch (protocolError) {
          if (!sessionGuard.isCurrent(session)) return { balanceLoaded: false };
          const message = `${operationError("Protocol state refresh", protocolError)} · ${safeErrorDetails(protocolError)}`;
          setError(message);
        }
        return { balanceLoaded: true };
      } catch (loadError) {
        if (!sessionGuard.isCurrent(session)) return { balanceLoaded: false };
        const message = operationError("Balance refresh", loadError);
        setBalanceStatus("error");
        setBalanceError(message);
        setError(message);
        return { balanceLoaded: false };
      } finally {
        if (sessionGuard.isCurrent(session)) setLoading(false);
      }
    })();
    const entry = { session, promise: request };
    refreshInFlightRef.current = entry;
    request.then(() => { if (refreshInFlightRef.current === entry) refreshInFlightRef.current = null; }, () => { if (refreshInFlightRef.current === entry) refreshInFlightRef.current = null; });
    return request;
  }, [contracts, sessionGuard, wallet.address, wallet.provider, wallet.status]);

  useEffect(() => {
    if (!wallet.provider || wallet.status !== "connected" || !wallet.address) {
      setContracts(undefined);
      setState(EMPTY_PUBLIC_STATE);
      setBalanceStatus("idle");
      return;
    }
    setContracts(readContracts(wallet.provider));
  }, [wallet.address, wallet.provider, wallet.status]);

  const wrapperSessionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (wrapperSessionRef.current === walletSessionKey) return;
    wrapperSessionRef.current = walletSessionKey;
    refreshInFlightRef.current = null;
    wrappedHandleRef.current = undefined;
    operationInFlightRef.current = false;
    setState(EMPTY_PUBLIC_STATE);
    setBalanceStatus("idle");
    setBalanceError(undefined);
    setReveals({ savings: { status: "idle" }, winnings: { status: "idle" } });
    setOperation(undefined);
    setModal(null);
    setAmount("");
    setWrappedBalance({ status: "idle" });
    setRecovery({ status: "idle" });
    setPartialDepositUnits(undefined);
    setFaucetStatus("idle");
    setFaucetError(undefined);
    setFaucetTxHash(undefined);
  }, [wallet.address, wallet.status, wallet.walletId, walletSessionKey]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const update = () => setNowSeconds(Math.floor(Date.now() / 1000));
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const session = sessionGuard.capture();
    if (!sessionGuard.isCurrent(session)) return;
    const handle = state.wrappedBalanceHandle;
    if (wrappedHandleRef.current === handle) return;
    wrappedHandleRef.current = handle;
    if (recovery.status === "complete") return;
    setWrappedBalance({ status: "idle" });
    setRecovery({ status: "idle" });
    if (!hasConfidentialBalance(handle)) setPartialDepositUnits(undefined);
  }, [recovery.status, state.wrappedBalanceHandle]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !operation) setModal(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [operation]);

  const configured = contractsConfigured && Boolean(contracts);
  const rightNetwork = wallet.status === "connected";
  const canTransact = configured && rightNetwork && Boolean(wallet.signer && wallet.ethereum && wallet.address);
  const savings = reveals.savings;
  const winnings = reveals.winnings;
  const roundState = displayRoundState(state.roundState);
  const currentRoundEvidence = useCurrentRoundDepositEvidence(wallet.provider, contractConfig.prizeEngine, contractConfig.veilPool, state.roundId, state.roundState, publicEvidenceRefresh);
  const thresholdReached = currentRoundEvidence.status === "verified" && currentRoundEvidence.depositors.length >= 2;
  const publicSchedule = usePublicRoundSchedule(state.roundId, state.roundState, nowSeconds, roundSchedule, thresholdReached, currentRoundEvidence.thresholdTimestamp);
  const roundMonitor = useMemo(() => roundMonitorView(state.roundId, state.roundState, nowSeconds, publicSchedule, currentRoundEvidence.status === "verified" ? currentRoundEvidence.depositors.length : undefined), [currentRoundEvidence.depositors.length, currentRoundEvidence.status, nowSeconds, publicSchedule, state.roundId, state.roundState]);
  const showFundedOverlay = thresholdReached && state.roundState === 0n && fundedOverlayRound !== state.roundId?.toString();
  const participationCopy = depositParticipationCopy(roundMonitor);

  const openModal = (kind: Exclude<ModalKind, null>, presetAmount?: string) => {
    operationInFlightRef.current = false;
    setAmount(presetAmount || "");
    setOperation(undefined);
    setError(undefined);
    setModal(kind);
  };

  const repeatOperation = () => {
    if (modal) openModal(modal);
  };

  const reveal = async (kind: RevealKind) => {
    if (!canTransact || !wallet.ethereum || !wallet.signer || !wallet.address) return;
    const handle = kind === "savings" ? state.savingsHandle : state.winningsHandle;
    if (!handle || !contractConfig.veilPool) return;
    const session = sessionGuard.capture();
    if (!sessionGuard.isCurrent(session)) return;
    setReveals((current) => ({ ...current, [kind]: { status: "requesting" } }));
    setError(undefined);
    try {
      const value = await decryptHandle(wallet.ethereum, wallet.signer, handle, contractConfig.veilPool, wallet.address);
      if (!sessionGuard.isCurrent(session)) return;
      setReveals((current) => ({ ...current, [kind]: { status: "revealed", value: typeof value === "boolean" ? undefined : value } }));
      addToast(`${kind === "savings" ? "Savings" : "Winnings"} revealed only to this wallet.`);
    } catch (revealError) {
      if (!sessionGuard.isCurrent(session)) return;
      setReveals((current) => ({ ...current, [kind]: { status: "failed" } }));
      setError(`${operationError(`${kind === "savings" ? "Savings" : "Winnings"} reveal`, revealError)} · ${safeErrorDetails(revealError)}`);
    }
  };

  const mintTestTokensForWallet = async () => {
    if (!canStartFaucetMint(faucetStatus)) return;
    const availability = faucetAvailability(wallet);
    if (availability !== "idle") {
      setFaucetStatus("idle");
      setFaucetError(availability === "wrong-network" ? "Switch to Sepolia before requesting test tokens." : "Connect a compatible EVM wallet before requesting test tokens.");
      return;
    }
    if (!contracts || !wallet.signer || !wallet.address || !contractConfig.underlyingToken) {
      setFaucetStatus("failure");
      setFaucetError("The configured test token is unavailable in this environment.");
      return;
    }
    const session = sessionGuard.capture();
    if (!sessionGuard.isCurrent(session)) return;
    try {
      setFaucetStatus("minting");
      setFaucetError(undefined);
      const token = contracts.underlying.connect(wallet.signer) as unknown as MintableToken;
      const hash = await mintTestTokens(token, wallet.address);
      if (!sessionGuard.isCurrent(session)) return;
      setFaucetTxHash(hash);
      setFaucetStatus("balance-refreshing");
      const refreshed = await refresh(true);
      if (!sessionGuard.isCurrent(session)) return;
      if (!refreshed.balanceLoaded) {
        setFaucetStatus("balance-read-failed");
        setFaucetError("Mint confirmed, but the balance read failed. Retry the balance refresh.");
        return;
      }
      setFaucetStatus("balance-loaded");
      addToast("100 mUNDER received. Balance loaded from Sepolia.");
    } catch (mintError) {
      if (!sessionGuard.isCurrent(session)) return;
      setFaucetStatus("failure");
      setFaucetError(`${operationError("Test token mint", mintError)} · ${safeErrorDetails(mintError)}`);
    }
  };

  const retryBalance = async () => {
    if (balanceStatus === "loading") return;
    const session = sessionGuard.capture();
    const refreshed = await refresh(true);
    if (!sessionGuard.isCurrent(session)) return;
    if (refreshed.balanceLoaded) {
      setFaucetStatus("balance-loaded");
      setFaucetError(undefined);
    } else {
      setFaucetStatus("balance-read-failed");
      setFaucetError("Balance read failed again. Check the wallet connection and RPC availability.");
    }
  };

  const revealWrappedBalance = async () => {
    if (!canTransact || !wallet.ethereum || !wallet.signer || !wallet.address || !contractConfig.confidentialToken || !state.wrappedBalanceHandle || !hasConfidentialBalance(state.wrappedBalanceHandle)) return;
    const session = sessionGuard.capture();
    if (!sessionGuard.isCurrent(session)) return;
    setWrappedBalance({ status: "requesting" });
    try {
      const value = await decryptHandle(wallet.ethereum, wallet.signer, state.wrappedBalanceHandle, contractConfig.confidentialToken, wallet.address);
      if (!sessionGuard.isCurrent(session)) return;
      if (typeof value !== "bigint") throw new Error("Confidential wrapper balance returned an unsupported value.");
      setWrappedBalance({ status: "revealed", value });
    } catch (revealError) {
      if (!sessionGuard.isCurrent(session)) return;
      setWrappedBalance({ status: "failed", error: `${operationError("Confidential balance review", revealError)} · ${safeErrorDetails(revealError)}` });
    }
  };

  const finalizeRecovery = async (requestId: string, expectedSession = sessionGuard.capture()) => {
    if (!canTransact || !wallet.ethereum || !wallet.signer || !wallet.address || !contracts || !contractConfig.confidentialToken) return;
    const session = expectedSession;
    if (!sessionGuard.isCurrent(session)) return;
    try {
      setRecovery((current) => ({ ...current, status: "decrypting", step: 3, requestId, waitingForWallet: false, error: undefined }));
      const publicDecryption = await publicDecryptHandle(wallet.ethereum, requestId);
      if (!sessionGuard.isCurrent(session)) return;
      const amount = publicDecryption.value;
      if (typeof amount !== "bigint") throw new Error("The wrapper recovery proof did not return an integer amount.");
      setRecovery((current) => ({ ...current, status: "preparing-finalization", step: 4, requestId, waitingForWallet: false, error: undefined, amount }));
      await yieldToUi();
      if (!sessionGuard.isCurrent(session)) return;
      setRecovery((current) => ({ ...current, status: "finalizing", step: 5, requestId, waitingForWallet: true }));
      const finalize = await (contracts.token.connect(wallet.signer) as ReadContracts["token"]).finalizeUnwrap(requestId, amount, publicDecryption.decryptionProof);
      if (!sessionGuard.isCurrent(session)) return;
      setRecovery((current) => ({ ...current, status: "finalizing-confirmation", step: 6, requestId, txHash: finalize.hash, waitingForWallet: false }));
      const hash = await waitForTransaction(finalize);
      if (!sessionGuard.isCurrent(session)) return;
      setRecovery((current) => ({ ...current, status: "complete", step: UNWRAP_PROGRESS_STEPS.length, txHash: hash, waitingForWallet: false }));
      setWrappedBalance({ status: "revealed", value: 0n });
      setPartialDepositUnits(undefined);
      await refresh(true);
    } catch (recoveryError) {
      if (!sessionGuard.isCurrent(session)) return;
      setRecovery((current) => ({ ...current, status: "failed", requestId, error: `${operationError("Recovery finalization", recoveryError)} · ${safeErrorDetails(recoveryError)}` }));
    }
  };

  const recoverWrappedBalance = async () => {
    if (recovery.status !== "idle" && recovery.status !== "complete" && recovery.status !== "failed") return;
    const session = sessionGuard.capture();
    if (!sessionGuard.isCurrent(session)) return;
    if (recovery.status === "failed" && recovery.requestId) {
      await finalizeRecovery(recovery.requestId, session);
      return;
    }
    if (!canTransact || !wallet.signer || !wallet.address || !contracts || !state.wrappedBalanceHandle || !hasConfidentialBalance(state.wrappedBalanceHandle)) return;
    try {
      setRecovery({ status: "preparing", step: 0, waitingForWallet: false });
      await yieldToUi();
      if (!sessionGuard.isCurrent(session)) return;
      setRecovery({ status: "requesting", step: 1, waitingForWallet: true });
      const unwrap = await (contracts.token.connect(wallet.signer) as ReadContracts["token"])["unwrap(address,address,bytes32)"](wallet.address, wallet.address, state.wrappedBalanceHandle);
      if (!sessionGuard.isCurrent(session)) return;
      setRecovery({ status: "confirming", step: 2, txHash: unwrap.hash, waitingForWallet: false });
      const receipt = await unwrap.wait();
      if (!sessionGuard.isCurrent(session)) return;
      if (!receipt) throw new Error("The unwrap request receipt was not returned.");
      const logs = receipt.logs as Array<{ topics: readonly string[]; data: string }>;
      const requestLog = logs.map((log) => {
        try { return contracts.token?.interface.parseLog({ topics: [...log.topics], data: log.data }); } catch { return null; }
      }).find((parsed: any) => parsed?.name === "UnwrapRequested");
      const requestId = requestLog?.args?.unwrapRequestId as string | undefined;
      if (!requestId) throw new Error("The unwrap request was confirmed, but no request identifier was found.");
      await finalizeRecovery(requestId, session);
    } catch (recoveryError) {
      if (!sessionGuard.isCurrent(session)) return;
      setRecovery((current) => ({ ...current, status: "failed", waitingForWallet: false, error: `${operationError("Confidential balance recovery", recoveryError)} · ${safeErrorDetails(recoveryError)}` }));
    }
  };

  const submitDeposit = async () => {
    if (!wallet.signer || !wallet.ethereum || !wallet.address || !contracts || !contractConfig.confidentialToken || !contractConfig.veilPool) return;
    if (!canBeginOperation(operationInFlightRef.current, operation)) return;
    if (balanceStatus !== "loaded") { setError(balanceError || "Balance is still loading. Refresh it before depositing."); return; }
    const validation = validateAmount(amount, undefined, state.underlyingDecimals);
    if (validation) { setError(validation); return; }
    const units = parseUnits(amount, state.underlyingDecimals);
    const session = sessionGuard.capture();
    if (!sessionGuard.isCurrent(session)) return;
    operationInFlightRef.current = true;
    let depositStage = "private deposit";
    let wrappedStepConfirmed = false;
    try {
      setError(undefined);
      setOperation({ kind: "deposit", step: 0, label: "Preparing deposit…", waitingForWallet: false });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (!sessionGuard.isCurrent(session)) return;
      setOperation({ kind: "deposit", step: 0, label: "Checking confidential balance", waitingForWallet: false });
      const wrappedHandle = String(await contracts.token.confidentialBalanceOf(wallet.address));
      if (!sessionGuard.isCurrent(session)) return;
      let wrappedAmount = 0n;
      if (hasConfidentialBalance(wrappedHandle)) {
        depositStage = "confidential balance authorization";
        const revealed = await decryptHandle(wallet.ethereum, wallet.signer, wrappedHandle, contractConfig.confidentialToken, wallet.address);
        if (!sessionGuard.isCurrent(session)) return;
        if (typeof revealed !== "bigint") throw new Error("Confidential wrapper balance returned an unsupported value.");
        wrappedAmount = revealed;
        setWrappedBalance({ status: "revealed", value: revealed });
      }
      const wrapAmount = requiredWrapAmount(units, wrappedAmount);
      wrappedStepConfirmed = wrappedAmount > 0n;
      if (wrapAmount > 0n) {
        const currentUnderlying = await readConfiguredUnderlyingBalance(contracts, wallet.address);
        if (!sessionGuard.isCurrent(session)) return;
        setState((current) => ({ ...current, underlyingBalance: currentUnderlying.value, underlyingDecimals: currentUnderlying.decimals }));
        if (wrapAmount > currentUnderlying.value) throw new Error("Your public mUNDER balance does not cover the missing confidential amount.");
        const allowance = safeBigInt(await contracts.underlying.allowance(wallet.address, contractConfig.confidentialToken));
        if (!sessionGuard.isCurrent(session)) return;
        if (allowance < wrapAmount) {
          setOperation({ kind: "deposit", step: 1, label: "Approving required amount", waitingForWallet: true });
          depositStage = "underlying approval";
          const approval = await (contracts.underlying.connect(wallet.signer) as ReadContracts["underlying"]).approve(contractConfig.confidentialToken, wrapAmount);
          if (!sessionGuard.isCurrent(session)) return;
          setOperation({ kind: "deposit", step: 1, label: "Approval submitted", waitingForWallet: false, txHash: approval.hash });
          await approval.wait();
          if (!sessionGuard.isCurrent(session)) return;
        }
        setOperation({ kind: "deposit", step: 2, label: `Wrapping ${trimUnits(wrapAmount, state.underlyingDecimals)} mUNDER`, waitingForWallet: true });
        depositStage = "confidential wrap";
        const wrap = await (contracts.token.connect(wallet.signer) as ReadContracts["token"]).wrap(wallet.address, wrapAmount);
        if (!sessionGuard.isCurrent(session)) return;
        setOperation({ kind: "deposit", step: 2, label: "Confidential wrap confirmed", waitingForWallet: false, txHash: wrap.hash });
        wrappedStepConfirmed = true;
        await wrap.wait();
        if (!sessionGuard.isCurrent(session)) return;
      }
      const isOperator = await contracts.token.isOperator(wallet.address, contractConfig.veilPool);
      if (!sessionGuard.isCurrent(session)) return;
      if (!isOperator) {
        setOperation({ kind: "deposit", step: 3, label: "Authorizing VeilPool", waitingForWallet: true });
        const expiry = BigInt(Math.floor(Date.now() / 1000) + OPERATOR_EXPIRY_DAYS * 24 * 60 * 60);
        depositStage = "VeilPool authorization";
        const authorization = await (contracts.token.connect(wallet.signer) as ReadContracts["token"]).setOperator(contractConfig.veilPool, expiry);
        if (!sessionGuard.isCurrent(session)) return;
        setOperation({ kind: "deposit", step: 3, label: "VeilPool authorization submitted", waitingForWallet: false, txHash: authorization.hash });
        await authorization.wait();
        if (!sessionGuard.isCurrent(session)) return;
      }
      setOperation({ kind: "deposit", step: 4, label: "Preparing encrypted deposit", waitingForWallet: false });
      depositStage = "encrypted input generation";
      const binding = depositInputBinding(contractConfig.confidentialToken, contractConfig.veilPool);
      const encrypted = await encryptUint64(wallet.ethereum, binding.contractAddress, binding.userAddress, units);
      if (!sessionGuard.isCurrent(session)) return;
      setOperation({ kind: "deposit", step: 5, label: "Submitting deposit", waitingForWallet: true });
      depositStage = "VeilPool deposit";
      const deposit = await (contracts.vault.connect(wallet.signer) as ReadContracts["vault"]).deposit(encrypted.handle, encrypted.inputProof);
      if (!sessionGuard.isCurrent(session)) return;
      setOperation({ kind: "deposit", step: 6, label: "Waiting for confirmation", waitingForWallet: false, txHash: deposit.hash });
      const hash = await waitForTransaction(deposit);
      if (!sessionGuard.isCurrent(session)) return;
      setOperation({ kind: "deposit", step: 7, label: "complete", waitingForWallet: false, txHash: hash });
      setPartialDepositUnits(undefined);
      setReveals({ savings: { status: "idle" }, winnings: { status: "idle" } });
      addToast("Deposit confirmed.");
      setPublicEvidenceRefresh((current) => current + 1);
      await refresh(true);
    } catch (depositError) {
      if (!sessionGuard.isCurrent(session)) return;
      const message = `${operationError(depositStage, depositError)} · ${safeErrorDetails(depositError)}`;
      if (wrappedStepConfirmed) {
        setPartialDepositUnits(units);
        const safeMessage = `${message} Deposit not completed. Your confidential wrapper balance remains available; retry will not wrap this amount again.`;
        setOperation((current) => ({ ...(current ?? { kind: "deposit", step: 4, label: "Deposit not completed", waitingForWallet: false }), label: "Deposit not completed", waitingForWallet: false, error: safeMessage }));
        setError(safeMessage);
      } else {
        setOperation((current) => ({ ...(current ?? { kind: "deposit", step: 0, label: "Deposit not completed", waitingForWallet: false }), label: "Deposit not completed", waitingForWallet: false, error: message }));
        setError(message);
      }
    } finally {
      if (sessionGuard.isCurrent(session)) operationInFlightRef.current = false;
    }
  };

  const submitWithdraw = async () => {
    if (!wallet.signer || !wallet.ethereum || !wallet.address || !contracts || !contractConfig.veilPool || savings.value === undefined) return;
    if (!canBeginOperation(operationInFlightRef.current, operation)) return;
    const validation = validateAmount(amount, savings.value, state.underlyingDecimals);
    if (validation) { setError(validation); return; }
    const units = parseUnits(amount, state.underlyingDecimals);
    const session = sessionGuard.capture();
    if (!sessionGuard.isCurrent(session)) return;
    operationInFlightRef.current = true;
    try {
      setError(undefined);
      setOperation({ kind: "withdraw", step: 0, label: "Preparing withdrawal…", waitingForWallet: false });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (!sessionGuard.isCurrent(session)) return;
      setOperation({ kind: "withdraw", step: 0, label: "Preparing withdrawal", waitingForWallet: false });
      const encrypted = await encryptUint64(wallet.ethereum, contractConfig.veilPool, wallet.address, units);
      if (!sessionGuard.isCurrent(session)) return;
      setOperation({ kind: "withdraw", step: 1, label: "Submitting withdrawal", waitingForWallet: true });
      const withdrawal = await (contracts.vault.connect(wallet.signer) as ReadContracts["vault"]).withdraw(encrypted.handle, encrypted.inputProof);
      if (!sessionGuard.isCurrent(session)) return;
      setOperation({ kind: "withdraw", step: 3, label: "Waiting for confirmation", waitingForWallet: false, txHash: withdrawal.hash });
      const hash = await waitForTransaction(withdrawal);
      if (!sessionGuard.isCurrent(session)) return;
      setReveals((current) => ({ ...current, savings: { status: "idle" } }));
      setOperation({ kind: "withdraw", step: 4, label: "complete", waitingForWallet: false, txHash: hash });
      addToast("Confidential withdrawal confirmed.");
      await refresh(true);
    } catch (withdrawError) {
      if (!sessionGuard.isCurrent(session)) return;
      const message = `${operationError("Private withdrawal", withdrawError)} · ${safeErrorDetails(withdrawError)}`;
      setOperation((current) => ({ ...(current ?? { kind: "withdraw", step: 0, label: "failed", waitingForWallet: false }), label: "failed", waitingForWallet: false, error: message }));
      setError(message);
    } finally {
      if (sessionGuard.isCurrent(session)) operationInFlightRef.current = false;
    }
  };

  const operationSubmit = modal === "deposit" ? submitDeposit : submitWithdraw;
  const resumeDeposit = () => {
    if (wrappedBalance.value === undefined || wrappedBalance.value <= 0n) return;
    const requested = partialDepositUnits && canResumeWithBalance(partialDepositUnits, wrappedBalance.value) ? partialDepositUnits : wrappedBalance.value;
    openModal("deposit", trimUnits(requested, state.underlyingDecimals));
  };
  const dismissRecovery = () => setRecovery({ status: "idle" });
  const privateEligibility = state.isParticipant ? "Encrypted" : "No position yet";
  const actionDisabledReason = !wallet.address ? "Connect your wallet to begin." : wallet.status === "wrong-network" ? "Switch to Sepolia to continue." : !contractsConfigured ? "Contracts are not configured." : "";

  return <div className="app-page">
    <header className="app-header"><div className="app-header__inner"><VeilPoolLogo /><span className="app-header__title">Dashboard</span><div className="app-header__actions"><NetworkStatus wallet={wallet} onSwitch={() => void switchToSepolia().catch((switchError) => setError(displayErrorMessage(switchError)))} /><ThemeToggle />{wallet.address ? <ConnectedWalletMenu address={wallet.address} displayAddress={formatAddress(wallet.address)} onDisconnect={resetWallet} /> : <Button onClick={() => void connect()} className="app-connect">Connect wallet <ArrowUpRight size={15} /></Button>}</div></div></header>
    <main className="app-main">
      <div className="app-breadcrumb"><a href="/"><ArrowLeft size={14} /> Back to home</a><span>Private user application</span></div>
      {wallet.status === "unsupported" && <div className="app-banner app-banner--error" role="alert"><WalletCards size={18} /><div><strong>Wallet unavailable</strong><p>Connect a compatible EVM wallet that supports EIP-1193 to use VeilPool.</p></div></div>}
      {wallet.status === "wrong-network" && <div className="app-banner app-banner--warning" role="alert"><Network size={18} /><div><strong>VeilPool runs on Sepolia</strong><p>Your wallet is on chain {wallet.chainId ?? "an unknown network"}.</p><button className="app-inline-action" onClick={() => void switchToSepolia().catch((switchError) => setError(displayErrorMessage(switchError)))}>Switch to Sepolia <ArrowUpRight size={14} /></button></div></div>}
      {!contractsConfigured && <ConfigBanner />}
      {wallet.status === "error" && wallet.error && <ErrorBanner message={wallet.error} onDismiss={() => setError(undefined)} />}
      {error && <ErrorBanner message={error} onDismiss={() => setError(undefined)} />}
      <section className="app-faucet" aria-labelledby="faucet-title">
        <div>
          <span className="app-kicker">Sepolia test asset</span>
          <h2 id="faucet-title">Get a test asset to try VeilPool.</h2>
          <p>mUNDER is a Sepolia test asset with no monetary value. It simulates the supported asset users would supply in a production deployment.</p>
          <div className="app-faucet__flow" aria-label="VeilPool asset flow"><span>mUNDER</span><ArrowUpRight size={12} /><span>Confidential wrapper</span><ArrowUpRight size={12} /><span>Private VeilPool deposit</span></div>
          <span className={`app-faucet__status app-faucet__status--${faucetStatus}`} aria-live="polite">{faucetStatus === "minting" ? "Minting Sepolia test asset…" : faucetStatus === "balance-refreshing" ? "Mint confirmed · refreshing balance…" : faucetStatus === "balance-loaded" ? `Balance loaded · ${trimUnits(state.underlyingBalance, state.underlyingDecimals)} mUNDER` : faucetStatus === "balance-read-failed" ? "Mint confirmed · balance read failed." : faucetStatus === "failure" ? "Test asset mint failed." : faucetAvailability(wallet) === "wrong-network" ? "Switch to Sepolia to continue." : faucetAvailability(wallet) === "wallet-required" ? "Connect a compatible wallet to continue." : "Ready to request a Sepolia test asset."}</span>
          {(faucetStatus === "failure" || faucetStatus === "balance-read-failed") && faucetError && <span className="app-faucet__error" role="alert">{faucetError}</span>}
          {(faucetStatus === "balance-loaded" || faucetStatus === "balance-read-failed") && faucetTxHash && <a className="app-faucet__tx" href={explorerTxUrl(faucetTxHash)} target="_blank" rel="noreferrer">View mint transaction <ExternalLink size={12} /></a>}
          <span className={`app-faucet__balance app-faucet__balance--${balanceStatus}`} aria-live="polite">Current test balance: <strong>{balanceStatusText(balanceStatus, balanceStatus === "loaded" ? state.underlyingBalance : undefined, state.underlyingDecimals)}</strong></span>
          {faucetStatus === "balance-read-failed" && <button className="app-inline-action" onClick={() => void retryBalance()} disabled={balanceStatus === "loading"}>Retry balance refresh <RefreshCw size={13} /></button>}
        </div>
        <Button onClick={() => void mintTestTokensForWallet()} disabled={faucetStatus === "minting"} className="app-faucet__button">{faucetStatus === "minting" ? "Minting…" : "Get 100 mUNDER"} <ArrowUpRight size={15} /></Button>
      </section>
      <WrappedBalanceNotice handle={state.wrappedBalanceHandle} status={wrappedBalance.status} value={wrappedBalance.value} error={wrappedBalance.error} decimals={state.underlyingDecimals} requestedUnits={partialDepositUnits} recovery={recovery} onReveal={() => void revealWrappedBalance()} onResume={resumeDeposit} onRecover={() => void recoverWrappedBalance()} onDismissRecovery={dismissRecovery} />
      <section className="app-account-hero dark-media-surface">
        <motion.img className="app-account-hero__image" src={DASHBOARD_ASSETS.user} alt="" aria-hidden="true" initial={reduced ? false : { opacity: 0, scale: 1.06 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: .9, ease: "easeOut" }} />
        <div className="app-account-hero__veil" aria-hidden="true" />
        <div className="app-account-hero__content">
          <section className="app-intro"><div><span className="app-kicker">VeilPool / User dashboard</span><h1>Your private<br /><em>savings,</em> in view.</h1><p>Confidential savings, private eligibility, and a public round lifecycle you can verify.</p></div><div className="app-intro__status"><span className="app-status-dot" /> {loading ? "Loading private state…" : wallet.status === "connected" ? "Wallet connected" : "Awaiting wallet"}<button aria-label="Refresh dashboard" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? "is-spinning" : ""} /></button></div></section>
          {loading && <VeilPoolLoader variant="inline" statusText="Loading private state…" supportingText="Encrypted handles stay in memory only." />}
          <motion.article className="app-private-card app-private-card--primary" initial={reduced ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .08, duration: .55 }}><div className="app-card-top"><div><span className="app-kicker">Private balance</span><h2>Your private savings</h2></div><span className="app-lock-chip"><LockKeyhole size={13} /> Encrypted</span></div>{state.isParticipant ? <RevealValue kind="savings" status={savings.status} value={savings.value} decimals={state.underlyingDecimals} onReveal={() => void reveal("savings")} onHide={() => setReveals((current) => ({ ...current, savings: { status: "idle" } }))} /> : <div className="app-empty-private"><strong>No savings yet.</strong><span>{depositEmptyStateMessage(roundMonitor)}</span></div>}<div className="app-private-card__actions"><Button onClick={() => openModal("deposit")} disabled={!canTransact}>{state.isParticipant ? "Add savings" : "Make your first private deposit"} <ArrowUpRight size={15} /></Button><Button variant="secondary" onClick={() => openModal("withdraw")} disabled={!canTransact || savings.value === undefined}>Withdraw <ArrowUpRight size={15} /></Button></div><p className="app-participation-note"><strong>{participationCopy.title}</strong>{participationCopy.supporting && <span>{participationCopy.supporting}</span>}</p>{actionDisabledReason && <p className="app-action-note">{actionDisabledReason}</p>}<div className="app-private-card__footer"><span><ShieldCheck size={14} /> No individual balance is public.</span><span>FHE protected</span></div></motion.article>
        </div>
      </section>
      <section className="app-dashboard-grid app-dashboard-grid--secondary">
        <motion.article className="app-private-card" initial={reduced ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .16, duration: .55 }}><div className="app-card-top"><div><span className="app-kicker">Private state</span><h2>Your winnings</h2></div><span className="app-lock-chip"><LockKeyhole size={13} /> Private</span></div>{state.isParticipant ? <RevealValue kind="winnings" status={winnings.status} value={winnings.value} decimals={state.underlyingDecimals} onReveal={() => void reveal("winnings")} onHide={() => setReveals((current) => ({ ...current, winnings: { status: "idle" } }))} /> : <div className="app-empty-private"><strong>No private winnings yet.</strong><span>Winnings stay encrypted until you authorize your own reveal.</span></div>}{shouldShowSettledWinningsMessage(state.roundState, winnings.status, winnings.value) && <SettledWinningsResult value={winnings.value!} decimals={state.underlyingDecimals} reduced={reduced} />}<div className="app-private-card__secondary"><span className="app-data-label">Your eligibility</span><strong>{privateEligibility}</strong><small>{state.isParticipant ? "Used for the confidential round snapshot." : "Join the pool to create encrypted eligibility."}</small></div></motion.article>
        <motion.article className="app-round-card app-round-card--yield dark-media-surface" initial={reduced ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .24, duration: .55 }}><motion.img className="app-round-card__image" src={DASHBOARD_ASSETS.yield} alt="" aria-hidden="true" initial={reduced ? false : { scale: 1.04 }} animate={{ scale: 1 }} transition={{ duration: 1.1, ease: "easeOut" }} /><div className="app-round-card__veil" aria-hidden="true" /><div className="app-card-top"><div><span className="app-kicker">Public protocol state</span><h2>Current round</h2></div><span className="app-round-dot" /></div><div className="app-round-id">{state.roundId === undefined ? "#—" : `#${state.roundId}`}</div><div className="app-round-state"><span>Status</span><strong>{roundMonitor.title}</strong><p>{roundMonitor.supporting}</p></div><div className="app-round-stats"><div><span>Participants</span><strong>{state.participantCount.toString()} <small>/ {state.maxParticipants.toString()}</small></strong></div><div><span>Prize source</span><strong>Generated yield</strong></div></div><RoundMonitor view={roundMonitor} /><VerificationPanel state={state} /></motion.article>
      </section>
      <section className="app-sync-panel"><div><span className="app-kicker">Phase 5 boundary</span><h2>Principal restoration</h2><p>{state.principalUnwrapPending ? "Principal restoration is awaiting protocol processing." : state.principalSyncPending ? "The protocol has requested an authorized principal synchronization." : "Confidential user withdrawals are complete when the vault confirms them. Underlying restoration is coordinated by the protocol operator when required."}</p></div><div className={`app-sync-state${state.principalUnwrapPending || state.principalSyncPending ? " app-sync-state--pending" : ""}`}><span className="app-status-dot" /> {state.principalUnwrapPending || state.principalSyncPending ? "Protocol processing" : "No pending sync reported"}</div></section>
      <section className="app-notes"><div><ShieldCheck size={17} /><strong>Privacy by default</strong><span>Only your connected wallet can request decryption for your authorized handles.</span></div><div><Network size={17} /><strong>Sepolia testnet</strong><span>Transactions and public round state are read from the configured deployment.</span></div><div><CircleHelp size={17} /><strong>Need a hand?</strong><span>Open the technical details in the verification panel for the public surface.</span></div></section>
    </main>
    <footer className="app-footer"><VeilPoolLogo compact /><span>VeilPool · Phase 6B user application · no operator controls</span><a href="https://sepolia.etherscan.io" target="_blank" rel="noreferrer">Sepolia Explorer <ExternalLink size={12} /></a></footer>
    <Toasts toasts={toasts} />
    {showFundedOverlay && <FundedRoundOverlay view={roundMonitor} reduced={reduced} onDismiss={() => setFundedOverlayRound(state.roundId?.toString())} />}
    {modal && <Modal kind={modal} amount={amount} setAmount={setAmount} state={operation} decimals={state.underlyingDecimals} available={modal === "deposit" ? (balanceStatus === "loaded" ? state.underlyingBalance : undefined) : savings.value} balanceStatus={modal === "deposit" ? balanceStatus : "loaded"} balanceError={balanceError} onClose={() => { if (!operation || operation.label === "complete" || operation.error) { setModal(null); setOperation(undefined); } }} onSubmit={() => void operationSubmit()} onRepeat={repeatOperation} />}
    <WalletSelector open={walletSelectionOpen} wallets={walletOptions} onClose={closeWalletSelection} onSelect={(walletId) => void connect(walletId)} />
  </div>;
}
