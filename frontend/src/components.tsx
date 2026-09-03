import { type ReactNode, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  Menu,
  Moon,
  ShieldCheck,
  Sparkles,
  Sun,
  X,
  WalletCards,
} from "lucide-react";

export function VeilPoolLogo({ compact = false }: { compact?: boolean }) {
  return (
    <a className={`brand${compact ? " brand--compact" : ""}`} href="/" aria-label="VeilPool home">
      <VeilPoolMark />
      <span className="brand-name">VeilPool</span>
    </a>
  );
}

export function VeilPoolMark({ className = "" }: { className?: string }) {
  return <span className={`brand-mark ${className}`} aria-hidden="true"><span /></span>;
}

export function Button({
  children,
  href,
  variant = "primary",
  className = "",
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  href?: string;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const classes = `button button--${variant} ${className}`;
  const reduced = useReducedMotion();
  const feedback = reduced ? undefined : { y: -1, scale: 1.012 };
  if (href) return <motion.a className={classes} href={href} whileHover={feedback} whileTap={reduced ? undefined : { scale: .99 }} transition={{ duration: .18, ease: "easeOut" }}>{children}</motion.a>;
  return <motion.button className={classes} onClick={onClick} disabled={disabled} whileHover={disabled ? undefined : feedback} whileTap={disabled || reduced ? undefined : { scale: .99 }} transition={{ duration: .18, ease: "easeOut" }}>{children}</motion.button>;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("veilpool-theme", next);
    setTheme(next);
  }

  return (
    <button className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
      {theme === "dark" ? <Sun size={17} strokeWidth={1.8} /> : <Moon size={17} strokeWidth={1.8} />}
    </button>
  );
}

export type WalletSelectorOption = {
  id: string;
  name: string;
  icon?: string;
  rdns?: string;
};

export function WalletSelector({ open, wallets, onSelect, onClose }: { open: boolean; wallets: WalletSelectorOption[]; onSelect: (walletId: string) => void; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;
  return <div className="wallet-selector-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="wallet-selector" role="dialog" aria-modal="true" aria-labelledby="wallet-selector-title"><div className="wallet-selector__header"><div><span className="eyebrow">VeilPool access</span><h2 id="wallet-selector-title">Connect a compatible EVM wallet</h2><p>Choose an installed wallet to continue on Sepolia.</p></div><button className="wallet-selector__close" aria-label="Close wallet selector" onClick={onClose}><X size={18} /></button></div><div className="wallet-selector__options">{wallets.map((wallet) => <button className="wallet-selector__option" key={wallet.id} onClick={() => onSelect(wallet.id)}>{wallet.icon ? <img src={wallet.icon} alt="" /> : <span className="wallet-selector__fallback"><WalletCards size={18} /></span>}<span><strong>{wallet.name}</strong><small>{wallet.rdns || "EIP-1193 provider"}</small></span><ArrowUpRight size={16} /></button>)}</div></section></div>;
}

export function ConnectedWalletMenu({ address, displayAddress, onDisconnect }: { address: string; displayAddress: string; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const copyResetRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const closeOnOutsidePointer = (event: PointerEvent) => { if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [open]);

  useEffect(() => () => { if (copyResetRef.current !== undefined) window.clearTimeout(copyResetRef.current); }, []);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      if (copyResetRef.current !== undefined) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return <div className="connected-wallet-menu" ref={menuRef}>
    <button className="wallet-account-button app-wallet" onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open}><WalletCards size={15} /> {displayAddress}<ChevronDown size={14} /></button>
    {open && <div className="connected-wallet-menu__popover" role="menu" aria-label="Connected wallet actions">
      <span className="connected-wallet-menu__label">Connected wallet</span>
      <strong>{displayAddress}</strong>
      <button role="menuitem" onClick={() => void copyAddress()}>{copied ? <><Check size={14} /> Copied</> : "Copy address"}</button>
      <button role="menuitem" onClick={() => { setOpen(false); onDisconnect(); }}>Disconnect wallet</button>
    </div>}
  </div>;
}

export type LoaderVariant = "inline" | "panel" | "overlay";

export function VeilPoolLoader({
  variant = "panel",
  statusText,
  supportingText,
  contained = false,
  className = "",
}: {
  variant?: LoaderVariant;
  statusText: string;
  supportingText?: string;
  contained?: boolean;
  className?: string;
}) {
  const content = <>
    <span className="loader-orbit" aria-hidden="true"><VeilPoolMark className="brand-mark--loader" /></span>
    <span className="loader-copy"><strong>{statusText}</strong>{supportingText && <small>{supportingText}</small>}</span>
  </>;

  if (variant === "inline") {
    return <span className={`loader loader--inline ${className}`} role="status" aria-live="polite" aria-busy="true">{content}</span>;
  }

  if (variant === "overlay") {
    return <div className={`loader-overlay${contained ? " loader-overlay--contained" : ""} ${className}`} role="status" aria-live="polite" aria-busy="true"><div className="loader loader--overlay">{content}</div></div>;
  }

  return <div className={`loader loader--panel ${className}`} role="status" aria-live="polite" aria-busy="true">{content}</div>;
}

export function WithdrawalProgress({ currentStep, steps = ["Preparing withdrawal", "Restoring principal", "Finalizing privacy", "Ready"], label = "Withdrawal" }: { currentStep: number; steps?: string[]; label?: string }) {
  const activeStep = Math.min(Math.max(currentStep, 0), steps.length - 1);
  return <div className="withdrawal-progress" role="status" aria-live="polite" aria-busy={activeStep < steps.length - 1} aria-label={`${label} status: ${steps[activeStep]}`}>
    <div className="withdrawal-progress__heading"><span>{label} progress</span><span>{activeStep + 1} / {steps.length}</span></div>
    <ol className="withdrawal-progress__steps">
      {steps.map((step, index) => <li className={`withdrawal-progress__step withdrawal-progress__step--${index < activeStep ? "complete" : index === activeStep ? "active" : "future"}`} key={step}>
        <span className="withdrawal-progress__marker">{index < activeStep ? <Check size={13} /> : index === activeStep ? <LoaderCircle size={14} /> : <span />}</span><span>{step}</span>
      </li>)}
    </ol>
  </div>;
}

export function Navbar() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, []);

  return (
    <header className="site-header">
      <div className="container nav-wrap">
        <VeilPoolLogo />
        <nav className={`desktop-nav${open ? " mobile-nav--open" : ""}`} aria-label="Primary navigation">
          <a href="#how-it-works" onClick={() => setOpen(false)}>How it works</a>
          <a href="#privacy" onClick={() => setOpen(false)}>Privacy</a>
          <a href="#technology" onClick={() => setOpen(false)}>Technology</a>
        </nav>
        <div className="nav-actions">
          <ThemeToggle />
          <Button href="/app" className="nav-cta">Launch app <ArrowUpRight size={15} /></Button>
          <button className="menu-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls="mobile-navigation" aria-label={open ? "Close menu" : "Open menu"}>
            {open ? <X size={21} /> : <Menu size={21} />}
          </button>
        </div>
      </div>
      <div id="mobile-navigation" className={`mobile-navigation${open ? " mobile-navigation--open" : ""}`}>
        <a href="#how-it-works" onClick={() => setOpen(false)}>How it works</a>
        <a href="#privacy" onClick={() => setOpen(false)}>Privacy</a>
        <a href="#technology" onClick={() => setOpen(false)}>Technology</a>
        <Button href="/app" onClick={() => setOpen(false)}>Launch app <ArrowUpRight size={15} /></Button>
      </div>
    </header>
  );
}

export function SectionHeading({ eyebrow, title, copy, align = "left" }: { eyebrow: string; title: ReactNode; copy?: string; align?: "left" | "center" }) {
  return (
    <div className={`section-heading section-heading--${align}`}>
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      {copy && <p>{copy}</p>}
    </div>
  );
}

export function PrivacyValue({ label, demoValue, className = "" }: { label: string; demoValue: string; className?: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className={`privacy-value ${className}`}>
      <div className="privacy-value__top"><span>{label}</span><LockKeyhole size={13} /></div>
      <div className={`privacy-value__number${revealed ? " is-revealed" : ""}`} aria-live="polite">
        <span className="privacy-value__hidden">••••••••</span>
        <span className="privacy-value__clear">{demoValue}</span>
      </div>
      <button className="reveal-button" onClick={() => setRevealed((value) => !value)} aria-label={`${revealed ? "Hide" : "Reveal"} illustrative ${label}`}>
        {revealed ? <><EyeOff size={13} /> Hide</> : <><Eye size={13} /> Reveal</>}
      </button>
    </div>
  );
}

export function HeroProductPreview() {
  return (
    <div className="hero-visual" aria-label="Illustrative VeilPool savings preview">
      <div className="hero-orbit hero-orbit--one" />
      <div className="hero-orbit hero-orbit--two" />
      <div className="floating-card round-card">
        <div className="card-label"><span>Current round</span><span className="status-dot" /></div>
        <div className="round-card__line"><strong>Round #04</strong><span className="status-pill">Open</span></div>
        <div className="participant-track"><span style={{ width: "70%" }} /></div>
        <span className="micro-copy">7 / 10 participants</span>
      </div>
      <div className="main-savings-card floating-card">
        <div className="card-label"><span>Your private savings</span><span className="private-chip"><LockKeyhole size={11} /> Private</span></div>
        <PrivacyValue label="Available balance" demoValue="1,250.00 cUSDT" />
        <div className="card-footer"><span><ShieldCheck size={14} /> Encrypted by default</span><ArrowUpRight size={16} /></div>
      </div>
      <div className="floating-card winnings-card">
        <div className="card-label"><span>Your winnings</span><Sparkles size={14} /></div>
        <div className="winnings-amount"><span>••••••</span><small>cUSDT</small></div>
        <span className="micro-copy">Confidential until you reveal</span>
      </div>
      <div className="yield-tag"><span className="yield-tag__icon"><ArrowUp size={14} /></span><span><small>Yield → prize</small><strong>Private by design</strong></span></div>
    </div>
  );
}

export function HowItWorks() {
  const steps = [
    { number: "01", title: "Save privately", copy: "Deposit into VeilPool without exposing your individual balance.", icon: LockKeyhole },
    { number: "02", title: "Earn together", copy: "Pooled savings generate yield through the protocol's yield strategy.", icon: ArrowUp },
    { number: "03", title: "Win privately", copy: "Generated yield becomes the prize while winnings stay confidential.", icon: Sparkles },
  ];
  return (
    <section className="section how-section" id="how-it-works">
      <div className="container">
        <SectionHeading eyebrow="The VeilPool model" title={<>Your money works.<br /><em>Your data doesn't leak.</em></>} copy="A simpler kind of prize savings: your principal stays yours, while the yield creates a fair shot at something extra." />
        <div className="steps-grid">{steps.map(({ number, title, copy, icon: Icon }, index) => <article className="step" key={number}>
          <div className="step__top"><span className="step-number">{number}</span><span className="step-icon"><Icon size={17} strokeWidth={1.7} /></span></div>
          <h3>{title}</h3><p>{copy}</p>
          {index < steps.length - 1 && <ArrowRight className="step-connector" size={20} />}
        </article>)}</div>
      </div>
    </section>
  );
}

export function PrivacyComparison() {
  const rows = [
    ["Wallet address", "Public", "Public", "shared"],
    ["Deposit amount", "Public", "Private", "private"],
    ["Savings balance", "Public", "Private", "private"],
    ["Eligibility / odds", "Public", "Private", "private"],
    ["Winnings", "Public", "Private", "private"],
    ["Round verification", "Public", "Public / verifiable", "verified"],
  ];
  return (
    <section className="section privacy-section" id="privacy">
      <div className="container">
        <SectionHeading eyebrow="Selective disclosure" title={<>Prize savings, without<br /><em>financial surveillance.</em></>} copy="The protocol reveals only what a round needs to be verifiable. The details that belong to you stay yours." />
        <div className="comparison-shell">
          <div className="comparison-head"><span>What is visible?</span><span>Traditional onchain savings</span><span className="comparison-head__veil"><span className="brand-mark brand-mark--tiny"><span /></span> VeilPool</span></div>
          {rows.map(([label, traditional, veil, tone]) => <div className="comparison-row" key={label}><strong>{label}</strong><span className="comparison-public">{traditional}</span><span className={`comparison-veil comparison-veil--${tone}`}><span className="comparison-symbol">{tone === "private" ? <LockKeyhole size={13} /> : tone === "verified" ? <Check size={14} /> : "•"}</span>{veil}</span></div>)}
        </div>
      </div>
    </section>
  );
}

export function ProductPreview() {
  return (
    <section className="section product-section">
      <div className="container product-layout">
        <SectionHeading eyebrow="A calmer money dashboard" title={<>Everything you need.<br /><em>Nothing you need to hide.</em></>} copy="A future-facing view of your savings, your current round, and your private winnings. Designed for clarity, not noise." />
        <div className="dashboard-preview" aria-label="Illustrative future VeilPool dashboard">
          <div className="dashboard-top"><span className="dashboard-kicker">Personal overview</span><span className="dashboard-date">Sepolia testnet <ChevronDown size={13} /></span></div>
          <div className="dashboard-grid">
            <div className="dashboard-balance preview-panel"><div className="panel-title"><span>Your private savings</span><span className="panel-lock"><LockKeyhole size={12} /></span></div><div className="dashboard-value">••••••••</div><span className="dashboard-muted">cUSDT · balance hidden</span><div className="dashboard-buttons"><Button variant="secondary">Deposit</Button><Button variant="ghost">Withdraw</Button></div></div>
            <div className="dashboard-round preview-panel"><div className="panel-title"><span>Current round</span><span className="status-pill">Open</span></div><strong className="dashboard-round-number">#04</strong><div className="round-stat"><span>Participants</span><strong>07 <small>/ 10</small></strong></div><div className="participant-track"><span style={{ width: "70%" }} /></div><span className="dashboard-muted">Prize powered by generated yield</span></div>
            <div className="dashboard-winnings preview-panel"><div className="panel-title"><span>Your winnings</span><Sparkles size={14} /></div><div className="dashboard-value">••••••••</div><span className="dashboard-muted">Reveal when you're ready</span><div className="dashboard-winnings__line"><span className="winnings-dot" /> Confidential reward</div></div>
          </div>
          <div className="dashboard-note"><ShieldCheck size={15} /><span>Your savings are encrypted. Only you can authorize a reveal.</span></div>
        </div>
      </div>
    </section>
  );
}

export function Technology() {
  const items = ["Confidential deposit", "ERC-7984", "Yield strategy", "Generated yield", "Encrypted weighted draw", "Private winnings"];
  return (
    <section className="section technology-section" id="technology">
      <div className="container technology-layout">
        <SectionHeading eyebrow="The technology" title={<>Private by design.<br /><em>Verifiable by anyone.</em></>} copy="VeilPool combines familiar savings mechanics with Zama FHE, so privacy doesn't have to come at the cost of trust." />
        <div className="architecture-flow">{items.map((item, index) => <div className="architecture-node" key={item}><div className={`architecture-node__box${index === 0 || index === items.length - 1 ? " architecture-node__box--accent" : ""}`}>{index === 0 ? <LockKeyhole size={15} /> : index === items.length - 1 ? <Sparkles size={15} /> : <span className="architecture-node__index">0{index}</span>}<span>{item}</span></div>{index < items.length - 1 && <ArrowDown className="architecture-arrow" size={16} />}</div>)}</div>
      </div>
    </section>
  );
}

export function PrincipalSafety() {
  return (
    <section className="section principal-section">
      <div className="container principal-layout">
        <div className="principal-copy"><span className="eyebrow">A different kind of prize</span><h2>Your savings<br /><em>aren't the prize.</em></h2><p>Your principal belongs to you. It stays separately accounted for while pooled savings generate the yield that funds prizes. Winning never requires another saver to lose their savings.</p><span className="testnet-note"><CircleHelp size={15} /> Testnet application · no financial guarantees</span></div>
        <div className="principal-diagram"><div className="principal-node principal-node--main"><LockKeyhole size={17} /><span>Your principal</span><small>remains user-owned</small></div><ArrowDown size={18} /><div className="principal-node"><ArrowUp size={17} /><span>Yield strategy</span><small>pooled productively</small></div><ArrowDown size={18} /><div className="principal-node principal-node--prize"><Sparkles size={17} /><span>Generated yield</span><small>becomes the prize</small></div></div>
      </div>
    </section>
  );
}

export function WithdrawalPreview() {
  return <div className="withdrawal-preview"><div className="withdrawal-preview__top"><span className="eyebrow">When you withdraw</span><span className="private-chip"><LockKeyhole size={11} /> Private flow</span></div><h3>Ready when you are.</h3><p>Behind the scenes, principal is restored privately before your withdrawal is finalized.</p><div className="withdrawal-steps"><span className="withdrawal-step withdrawal-step--done"><Check size={13} /> Preparing withdrawal</span><span className="withdrawal-line" /><span className="withdrawal-step"><ArrowUp size={13} /> Restoring principal</span><span className="withdrawal-line" /><span className="withdrawal-step"><ShieldCheck size={13} /> Ready</span></div></div>;
}

export function FinalCTA() {
  return <section className="section final-section"><div className="container final-card"><span className="eyebrow">The quiet advantage</span><h2>Your savings shouldn't<br /><em>be public information.</em></h2><p>Save privately. Win fairly.</p><Button href="/app">Launch VeilPool <ArrowUpRight size={16} /></Button><div className="final-mark" aria-hidden="true"><span className="brand-mark brand-mark--large"><span /></span></div></div></section>;
}

export function Footer() {
  return <footer className="site-footer"><div className="container footer-grid"><div><VeilPoolLogo /><p>Private prize savings<br />powered by Zama FHE.</p></div><div className="footer-links"><span className="footer-label">Explore</span><a href="#how-it-works">How it works</a><a href="#privacy">Privacy</a><a href="#technology">Technology</a></div><div className="footer-links"><span className="footer-label">Network</span><span>Sepolia Testnet</span><span className="footer-muted">Phase 6A preview</span></div><div className="footer-links footer-links--right"><span className="footer-label">Built for privacy</span><span className="footer-badge"><ShieldCheck size={14} /> Zama FHE</span></div></div><div className="container footer-bottom"><span>© 2026 VeilPool</span><span>VeilPool is currently a testnet application. Test tokens have no monetary value.</span></div></footer>;
}
