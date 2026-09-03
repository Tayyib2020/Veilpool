import { useEffect, useRef, useState } from "react";
import { motion, useInView, useMotionValueEvent, useReducedMotion, useScroll, useTransform } from "motion/react";
import { createTimeline } from "animejs";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  Eye,
  EyeOff,
  LockKeyhole,
  Menu,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { Button, ThemeToggle, VeilPoolLogo, VeilPoolMark } from "./components";

const ASSETS = {
  hero: "/images/hero.png",
  privacy: "/images/privacy.png",
  principal: "/images/principal.png",
  yield: "/images/yield.png",
  finalCta: "/images/final-cta.png",
} as const;

const DEMO = {
  wallet: "0x82f...31c",
  deposit: "1,250.00 cUSDT",
  savings: "4,870.32 cUSDT",
  eligibility: "24.7%",
  winnings: "320.00 cUSDT",
} as const;

function PhotographyNav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { scrollY } = useScroll();
  useMotionValueEvent(scrollY, "change", (latest) => setScrolled(latest > 28));
  const close = () => setOpen(false);
  return <header className={`photo-nav${scrolled ? " photo-nav--scrolled" : ""}`}>
    <div className="photo-nav__inner">
      <VeilPoolLogo />
      <nav id="photo-primary-navigation" className={`photo-nav__links${open ? " photo-nav__links--open" : ""}`} aria-label="Primary navigation">
        <a href="#journey" onClick={close}>How it works</a>
        <a href="#privacy" onClick={close}>Privacy</a>
        <a href="#technology" onClick={close}>Technology</a>
      </nav>
      <div className="photo-nav__actions">
        <ThemeToggle />
        <Button href="/app" className="photo-nav__cta">Enter app <ArrowUpRight size={14} /></Button>
        <button className="photo-nav__menu" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls="photo-primary-navigation" aria-label={open ? "Close menu" : "Open menu"}>{open ? <X size={20} /> : <Menu size={20} />}</button>
      </div>
    </div>
  </header>;
}

function HeroBalance() {
  const clearRef = useRef<HTMLSpanElement>(null);
  const partialRef = useRef<HTMLSpanElement>(null);
  const encryptedRef = useRef<HTMLSpanElement>(null);
  const lockRef = useRef<HTMLSpanElement>(null);
  const pulseRef = useRef<HTMLSpanElement>(null);
  const [revealed, setRevealed] = useState(false);
  const revealTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const clear = clearRef.current;
    const partial = partialRef.current;
    const encrypted = encryptedRef.current;
    const lock = lockRef.current;
    const pulse = pulseRef.current;
    if (!clear || !partial || !encrypted || !lock || !pulse) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      clear.style.opacity = "0";
      partial.style.opacity = "0";
      encrypted.style.opacity = "1";
      lock.style.opacity = "1";
      return;
    }
    let timeline: ReturnType<typeof createTimeline> | undefined;
    const startTimer = window.setTimeout(() => {
      timeline = createTimeline({ defaults: { ease: "out(3)" } });
      timeline
        .add(clear, { opacity: [1, 0], translateY: [0, -7], duration: 250 })
        .add(partial, { opacity: [0, 1, 0], translateY: [7, 0, -6], duration: 280 }, "-=55")
        .add(pulse, { opacity: [0, 1, 0], scale: [.96, 1.08, 1], duration: 320 }, "-=165")
        .add(encrypted, { opacity: [0, 1], translateY: [8, 0], duration: 310 }, "-=115")
        .add(lock, { opacity: [0, 1], scale: [.82, 1], duration: 270 }, "-=110");
    }, 1050);
    return () => {
      window.clearTimeout(startTimer);
      timeline?.pause();
      if (revealTimer.current) window.clearTimeout(revealTimer.current);
    };
  }, []);

  const revealExample = () => {
    setRevealed(true);
    if (revealTimer.current) window.clearTimeout(revealTimer.current);
    revealTimer.current = window.setTimeout(() => setRevealed(false), 1800);
  };

  return <div className={`photo-balance${revealed ? " photo-balance--revealed" : ""}`} aria-label="Illustrative private savings preview">
    <div className="photo-balance__top"><span>Your private savings</span><span><LockKeyhole size={13} /> Encrypted</span></div>
    <div className="photo-balance__value"><span ref={clearRef} className="photo-balance__clear">1,250.00 cUSDT</span><span ref={partialRef} className="photo-balance__partial">1,2••.••</span><span ref={encryptedRef} className="photo-balance__encrypted">••••••••</span><span ref={pulseRef} className="photo-balance__pulse" /><span ref={lockRef} className="photo-balance__lock"><LockKeyhole size={18} /></span></div>
    <div className="photo-balance__bottom"><span>Encrypted by default</span><button onClick={revealExample} aria-pressed={revealed}><Eye size={14} /> {revealed ? "Hide" : "Reveal"} <ArrowUpRight size={13} /></button></div>
  </div>;
}

function PhotoHero() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const imageY = useTransform(scrollYProgress, [0, 1], ["0%", "5%"]);
  const imageScale = useTransform(scrollYProgress, [0, 1], [1, 1.025]);
  const copyY = useTransform(scrollYProgress, [0, 1], [0, 52]);
  const overlayY = useTransform(scrollYProgress, [0, 1], [0, -20]);
  return <section className="photo-hero" ref={ref}>
    <motion.figure className="photo-hero__image" initial={reduced ? false : { opacity: 0, clipPath: "inset(0 0 0 8%)", scale: 1.04 }} animate={{ opacity: 1, clipPath: "inset(0 0 0 0%)", scale: 1 }} transition={{ duration: 1.15, ease: [.22, 1, .36, 1] }} style={{ y: reduced ? 0 : imageY, scale: reduced ? 1 : imageScale }}><img src={ASSETS.hero} alt="A person handling coins beside a calculator and notebook" fetchPriority="high" /></motion.figure>
    <div className="photo-hero__veil" />
    <div className="photo-hero__content">
      <motion.div className="photo-hero__copy" initial={reduced ? false : { opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .16, duration: .78, ease: [.22, 1, .36, 1] }} style={{ y: reduced ? 0 : copyY }}>
        <motion.span className="photo-eyebrow" initial={reduced ? false : { opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: .2, duration: .6 }}><i /> Private prize savings</motion.span>
        <h1><motion.span className="photo-hero__headline-line" initial={reduced ? false : { opacity: 0, y: 34 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .32, duration: .72, ease: [.22, 1, .36, 1] }}>Save privately.</motion.span><motion.span className="photo-hero__headline-line photo-hero__headline-line--accent" initial={reduced ? false : { opacity: 0, y: 34 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .44, duration: .72, ease: [.22, 1, .36, 1] }}>Win fairly.</motion.span></h1>
        <motion.p initial={reduced ? false : { opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .62, duration: .65 }}>Save together and win generated yield without exposing your savings, eligibility or winnings.</motion.p>
        <motion.div className="photo-hero__actions" initial={reduced ? false : { opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .76, duration: .65 }}><Button href="/app">Enter VeilPool <ArrowUpRight size={16} /></Button><a href="#journey">See how it works <ArrowDownRight size={15} /></a></motion.div>
        <motion.div className="photo-trust" initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: .92, duration: .7 }}><ShieldCheck size={14} /> Powered by <span className="zama-accent">Zama FHE</span> <span>·</span> Sepolia Testnet</motion.div>
      </motion.div>
      <motion.div className="photo-hero__balance" initial={reduced ? false : { opacity: 0, x: 24, y: 12 }} animate={{ opacity: 1, x: 0, y: 0 }} transition={{ delay: 1.08, duration: .8, ease: [.22, 1, .36, 1] }} style={{ y: reduced ? 0 : overlayY }}><HeroBalance /></motion.div>
    </div>
    <div className="photo-hero__footer"><span>Save privately. Win fairly.</span><span>01 / VeilPool</span></div>
  </section>;
}

function PrincipalSection() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const imageY = useTransform(scrollYProgress, [0, 1], ["1%", "-1%"]);
  const imageScale = useTransform(scrollYProgress, [0, 1], [1.015, 1]);
  const reveal = reduced ? undefined : { opacity: 1, y: 0 };
  return <section className="principal-photo" ref={ref}>
    <motion.div className="principal-photo__copy" initial={reduced ? false : { opacity: 0, y: 28 }} whileInView={reveal} viewport={{ once: true, amount: .25 }} transition={{ duration: .75, ease: [.22, 1, .36, 1] }}><span className="photo-eyebrow photo-eyebrow--dark"><i /> 02 / Principal</span><h2>Your savings<br /><em>aren't the prize.</em></h2><p>VeilPool separates what you save from what the pool generates.</p><p>Your principal remains yours. The generated yield becomes the prize.</p><div className="principal-equation">PRINCIPAL <span>≠</span> PRIZE</div></motion.div>
    <motion.div className="principal-photo__visual" initial={reduced ? false : { opacity: 0, x: 30 }} whileInView={reveal} viewport={{ once: true, amount: .2 }} transition={{ delay: .14, duration: .9, ease: [.22, 1, .36, 1] }}><motion.img src={ASSETS.principal} alt="Brutalist concrete architecture viewed from below" loading="lazy" style={{ y: reduced ? 0 : imageY, scale: reduced ? 1 : imageScale }} /></motion.div>
  </section>;
}

function YieldSection() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const imageY = useTransform(scrollYProgress, [0, 1], ["4%", "-4%"]);
  const imageScale = useTransform(scrollYProgress, [0, 1], [1.04, 1]);
  const contentOpacity = useTransform(scrollYProgress, [.1, .35], [0, 1]);
  const accentOpacity = useTransform(scrollYProgress, [.28, .52], [0, 1]);
  return <section className="yield-photo" ref={ref}>
    <motion.img className="yield-photo__image" src={ASSETS.yield} alt="Silver light reflecting across dark water" loading="lazy" initial={reduced ? false : { opacity: 0, scale: 1.08 }} whileInView={reduced ? undefined : { opacity: 1, scale: 1.04 }} viewport={{ once: true, amount: .2 }} transition={{ duration: 1.1, ease: [.22, 1, .36, 1] }} style={{ y: reduced ? 0 : imageY, scale: reduced ? 1 : imageScale }} />
    <div className="yield-photo__veil" />
    <motion.span className="yield-photo__accent" style={{ opacity: reduced ? 1 : accentOpacity }} aria-hidden="true" />
    <motion.div className="yield-photo__content" initial={reduced ? false : { opacity: 0, y: 28 }} whileInView={reduced ? undefined : { opacity: 1, y: 0 }} viewport={{ once: true, amount: .28 }} transition={{ duration: .8, ease: [.22, 1, .36, 1] }} style={{ opacity: reduced ? 1 : contentOpacity }}><motion.span className="photo-eyebrow" initial={reduced ? false : { opacity: 0, x: -12 }} whileInView={reduced ? undefined : { opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ delay: .12, duration: .55 }}><i /> 03 / Generated yield</motion.span><h2>Generated yield.<br /><em>Private prize.</em></h2><p>The pool's generated yield funds the prize. Your deposited principal does not.</p><div className="yield-sequence"><span>SAVE</span><ArrowDownRight size={15} /><span>GENERATE YIELD</span><ArrowDownRight size={15} /><span>DRAW</span><ArrowDownRight size={15} /><span>PRIVATE WINNINGS</span></div></motion.div>
    <div className="yield-photo__edge"><span>Yield separates</span><span>Principal remains</span></div>
  </section>;
}

function PrivacySection() {
  const reduced = useReducedMotion();
  const [privacy, setPrivacy] = useState(100);
  const isPrivate = privacy >= 50;
  const privateProgress = privacy / 100;
  const values = [["Deposit", DEMO.deposit], ["Savings", DEMO.savings], ["Eligibility", DEMO.eligibility], ["Winnings", DEMO.winnings]];
  return <section className="privacy-photo" id="privacy">
    <motion.div className="privacy-photo__intro" initial={reduced ? false : { opacity: 0, y: 25 }} whileInView={reduced ? undefined : { opacity: 1, y: 0 }} viewport={{ once: true, amount: .25 }} transition={{ duration: .75, ease: [.22, 1, .36, 1] }}><span className="photo-eyebrow photo-eyebrow--dark"><i /> 04 / Selective disclosure</span><h2>Onchain doesn't have to mean<br /><em>on display.</em></h2><p>VeilPool keeps individual savings, eligibility and winnings encrypted while preserving a publicly verifiable round lifecycle.</p></motion.div>
    <div className="privacy-photo__layout">
      <motion.div className="privacy-photo__image" initial={reduced ? false : { opacity: 0, x: -24 }} whileInView={reduced ? undefined : { opacity: 1, x: 0 }} viewport={{ once: true, amount: .2 }} transition={{ delay: .12, duration: .85, ease: [.22, 1, .36, 1] }}><motion.img src={ASSETS.privacy} alt="Obscured people behind textured frosted glass" loading="lazy" initial={reduced ? false : { scale: 1.06 }} whileInView={reduced ? undefined : { scale: 1 }} viewport={{ once: true }} transition={{ duration: 1.15, ease: [.22, 1, .36, 1] }} /><span>Individual financial state<br />stays encrypted.</span></motion.div>
      <motion.div className="privacy-photo__interface" initial={reduced ? false : { opacity: 0, x: 24 }} whileInView={reduced ? undefined : { opacity: 1, x: 0 }} viewport={{ once: true, amount: .2 }} transition={{ delay: .16, duration: .8, ease: [.22, 1, .36, 1] }}>
        <div className="privacy-statement"><div className="privacy-statement__top"><span>Illustrative privacy preview</span><span>VeilPool / #04</span></div><div className="privacy-statement__wallet"><span>Wallet</span><strong>{DEMO.wallet}</strong></div><div className="privacy-statement__rows">{values.map(([label, value]) => <div className="privacy-statement__row" key={label}><span>{label}</span><motion.strong aria-label={isPrivate ? `${label}: encrypted value` : `${label}: ${value}`}><motion.span className="privacy-value-clear" aria-hidden="true" animate={{ opacity: 1 - privateProgress, filter: `blur(${privateProgress * 4}px)` }} transition={{ duration: reduced ? 0 : .42, ease: "easeOut" }}>{value}</motion.span><motion.span className="privacy-value-private" aria-hidden="true" animate={{ opacity: privateProgress, filter: `blur(${(1 - privateProgress) * 2}px)` }} transition={{ duration: reduced ? 0 : .42, ease: "easeOut" }}>••••••••</motion.span></motion.strong></div>)}</div><div className="privacy-statement__public"><span>Round #04</span><strong><span className="proof-dot" /> Verified <Check size={13} /></strong></div></div>
        <div className="privacy-control"><div className="privacy-control__heading"><span>Privacy layer</span><motion.strong animate={{ color: isPrivate ? "#7357E8" : "#71809B" }} transition={{ duration: reduced ? 0 : .28 }}>{isPrivate ? "Private" : "Visible"}</motion.strong></div><div className="privacy-control__switch" role="group" aria-label="Privacy display mode"><button type="button" className={!isPrivate ? "privacy-control__switch-button--active" : ""} aria-pressed={!isPrivate} onClick={() => setPrivacy(0)}><Eye size={14} /> Visible</button><button type="button" className={isPrivate ? "privacy-control__switch-button--active" : ""} aria-pressed={isPrivate} onClick={() => setPrivacy(100)}><EyeOff size={14} /> Private</button></div><div className="privacy-control__track"><motion.div className="privacy-control__fill" initial={{ scaleX: 1 }} animate={{ scaleX: privateProgress }} transition={{ duration: reduced ? 0 : .35, ease: "easeOut" }} style={{ transformOrigin: "left" }} /><input className="privacy-control__range" type="range" min="0" max="100" step="1" value={Math.round(privacy)} onChange={(event) => setPrivacy(Number(event.target.value))} onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); setPrivacy(Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100))); }} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) event.preventDefault(); if (event.key === "ArrowLeft") setPrivacy((value) => Math.max(0, value - 1)); if (event.key === "ArrowRight") setPrivacy((value) => Math.min(100, value + 1)); if (event.key === "Home") setPrivacy(0); if (event.key === "End") setPrivacy(100); }} aria-label="Privacy control" aria-valuetext={`${Math.round(privacy)}% ${isPrivate ? "private" : "visible"}`} /></div><div className="privacy-control__ends"><span>Visible</span><span>Private</span></div><p>Choose a mode, drag the control, or use the arrow keys to preview the privacy layer.</p><div className="privacy-control__note"><ShieldCheck size={15} /><span>Round #04 and Verified remain public.</span></div></div>
      </motion.div>
    </div>
  </section>;
}

function ProductPreview() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, amount: .2 });
  const reveal = reduced ? false : { opacity: inView ? 1 : 0, y: inView ? 0 : 24 };
  return <section className="product-photo" ref={ref}><motion.div className="product-photo__intro" initial={reduced ? false : { opacity: 0, y: 24 }} animate={reveal} transition={{ duration: .75, ease: [.22, 1, .36, 1] }}><span className="photo-eyebrow"><i /> 05 / Private product</span><h2>Your money.<br /><em>Your eyes only.</em></h2><p>A calm, illustrative view of the savings product. No wallet or contract state is connected yet.</p></motion.div><motion.div className="product-dashboard" initial={reduced ? false : { opacity: 0, y: 30 }} animate={reveal} transition={{ delay: .16, duration: .85, ease: [.22, 1, .36, 1] }}><div className="product-dashboard__top"><div><span>VeilPool</span><strong>Round #04 · OPEN</strong></div><span className="product-dashboard__network"><span /> Sepolia Testnet</span></div><div className="product-dashboard__body"><div className="product-dashboard__primary"><div className="product-dashboard__label"><span>Your private savings</span><span><LockKeyhole size={13} /> Encrypted</span></div><div className="product-dashboard__amount">••••••••</div><div className="product-dashboard__reveal"><span>Authorized view only</span><button aria-label="Reveal illustrative savings"><Eye size={14} /> Reveal</button></div><motion.div className="product-dashboard__actions" initial={reduced ? false : { opacity: 0, y: 12 }} animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }} transition={{ delay: .48, duration: .5 }}><Button variant="secondary">Deposit</Button><Button variant="ghost">Withdraw</Button></motion.div></div><div className="product-dashboard__side"><div><span className="product-dashboard__label">Your winnings</span><strong>••••••••</strong><button aria-label="Reveal illustrative winnings"><EyeOff size={14} /> Reveal</button></div><div><span className="product-dashboard__label">Generated prize</span><strong className="product-dashboard__violet">Yield funded</strong><small>Only generated yield enters the draw.</small></div><div><span className="product-dashboard__label">Participants</span><strong>7 <small>/ 10</small></strong><div className="product-dashboard__progress"><span /></div></div></div></div><div className="product-dashboard__footer"><span><Check size={13} /> Principal used for prize <b>0</b></span><span><Check size={13} /> Encrypted draw <b>Ready</b></span><span><span className="proof-dot" /> Publicly verifiable <b>Yes</b></span></div></motion.div></section>;
}

function HowWorksSection() {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const inView = useInView(ref, { once: true, amount: .2 });
  const steps = [["01", "SAVE PRIVATELY", "Your deposit enters the pool without becoming public data."], ["02", "EARN TOGETHER", "The pool's strategy separates generated yield from principal."], ["03", "WIN PRIVATELY", "An encrypted draw funds a private prize for the winner."]];
  return <section className="how-photo" id="journey" ref={ref}><motion.div className="how-photo__heading" initial={reduced ? false : { opacity: 0, y: 24 }} animate={{ opacity: inView || reduced ? 1 : 0, y: inView || reduced ? 0 : 24 }} transition={{ duration: .75, ease: [.22, 1, .36, 1] }}><span className="photo-eyebrow"><i /> 06 / How it works</span><h2>Everybody can verify the game.<br /><em>Nobody needs your balance.</em></h2></motion.div><div className="how-photo__steps">{steps.map(([number, title, copy], index) => <motion.article key={number} initial={reduced ? false : { opacity: 0, y: 22 }} animate={{ opacity: inView ? 1 : 0, y: inView || reduced ? 0 : 22 }} transition={{ delay: index * .14, duration: .55 }}><span className="how-photo__number">{number}</span><h3>{title}</h3><p>{copy}</p></motion.article>)}</div></section>;
}

function TechnologySection() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, amount: .25 });
  return <section className="technology-photo" id="technology" ref={ref}><motion.div initial={reduced ? false : { opacity: 0, x: -20 }} animate={{ opacity: inView || reduced ? 1 : 0, x: inView || reduced ? 0 : -20 }} transition={{ duration: .7 }}><span className="photo-eyebrow"><i /> 07 / Under the veil</span><h2>Private by design.<br /><em>Verifiable by anyone.</em></h2></motion.div><motion.div className="technology-photo__copy" initial={reduced ? false : { opacity: 0, y: 22 }} animate={{ opacity: inView || reduced ? 1 : 0, y: inView || reduced ? 0 : 22 }} transition={{ delay: .15, duration: .7 }}><p>The protocol keeps financial state confidential while making the round lifecycle legible and verifiable.</p><div className="technology-photo__flow"><span>Confidential deposit</span><ArrowRight size={15} /><span>ERC-7984</span><ArrowRight size={15} /><span>Yield adapter</span><ArrowRight size={15} /><span>Generated yield</span><ArrowRight size={15} /><span>Encrypted draw</span><ArrowRight size={15} /><span>Private winnings</span></div><div className="technology-photo__tags"><span className="zama-accent">Zama FHE</span><span>ERC-7984</span><span>ERC-4626 adapter</span><span>Sepolia</span></div></motion.div></section>;
}

function FinalCta() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, amount: .2 });
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const imageY = useTransform(scrollYProgress, [0, 1], ["4%", "-4%"]);
  const imageScale = useTransform(scrollYProgress, [0, 1], [1.04, 1]);
  return <section className="final-photo" ref={ref}><motion.img src={ASSETS.finalCta} alt="Dark platform lit by a dramatic beam of light" loading="lazy" initial={reduced ? false : { opacity: 0, scale: 1.08 }} whileInView={reduced ? undefined : { opacity: 1, scale: 1.04 }} viewport={{ once: true, amount: .2 }} transition={{ duration: 1.2, ease: [.22, 1, .36, 1] }} style={{ y: reduced ? 0 : imageY, scale: reduced ? 1 : imageScale }} /><div className="final-photo__veil" /><motion.div className="final-photo__content" initial={reduced ? false : { opacity: 0, y: 28 }} animate={{ opacity: inView || reduced ? 1 : 0, y: inView || reduced ? 0 : 28 }} transition={{ duration: .8, ease: [.22, 1, .36, 1] }}><motion.span className="photo-eyebrow" initial={reduced ? false : { opacity: 0, x: -12 }} animate={{ opacity: inView || reduced ? 1 : 0, x: inView || reduced ? 0 : -12 }} transition={{ delay: .12, duration: .55 }}><i /> A more private future</motion.span><h2>Your money can be onchain.<br /><em>Your financial life doesn't have to be.</em></h2><p>Save privately. Earn together. Win fairly.</p><motion.div initial={reduced ? false : { opacity: 0, y: 14 }} animate={{ opacity: inView || reduced ? 1 : 0, y: inView || reduced ? 0 : 14 }} transition={{ delay: .42, duration: .55 }}><Button href="/app">Enter VeilPool <ArrowUpRight size={16} /></Button></motion.div></motion.div><div className="final-photo__footer"><span>Powered by <span className="zama-accent">Zama FHE</span></span><span>Sepolia Testnet</span><a href="https://github.com" target="_blank" rel="noreferrer">GitHub</a><a href="#technology">Technology</a><a href="#privacy">Privacy</a></div></section>;
}

export default function PhotographyLanding() {
  return <div className="photo-page"><PhotographyNav /><main><PhotoHero /><PrincipalSection /><YieldSection /><PrivacySection /><ProductPreview /><HowWorksSection /><TechnologySection /><FinalCta /></main><footer className="photo-footer"><VeilPoolLogo /><span>© 2026 VeilPool · Testnet application · illustrative UI only</span><VeilPoolMark className="photo-footer__mark" /></footer></div>;
}
