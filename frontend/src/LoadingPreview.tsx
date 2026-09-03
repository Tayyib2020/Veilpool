import { useState } from "react";
import { ArrowLeft, CircleHelp, LockKeyhole, RotateCcw, ShieldCheck } from "lucide-react";
import { Button, Navbar, SectionHeading, VeilPoolLoader, WithdrawalProgress } from "./components";

// Development-only visual showcase. These controls never call a wallet,
// contract, decryption service, or timer; Phase 6B will own real state.
const STATUS_PRESETS = [
  { label: "Connecting wallet", status: "Connecting wallet...", supporting: "Looking for a compatible wallet." },
  { label: "Encrypting amount", status: "Encrypting amount...", supporting: "Your amount stays private while it is prepared." },
  { label: "Revealing balance", status: "Revealing your balance...", supporting: "Only your authorized account can view this value." },
  { label: "Restoring principal", status: "Restoring principal...", supporting: "Moving your savings back into the private pool." },
  { label: "Finalizing privacy", status: "Finalizing privacy...", supporting: "One last confirmation before your savings are ready." },
  { label: "Settling draw", status: "Settling draw...", supporting: "Verifying the round without exposing private weights." },
];

export default function LoadingPreview() {
  const [selectedStatus, setSelectedStatus] = useState(0);
  const [withdrawalStep, setWithdrawalStep] = useState(1);
  const status = STATUS_PRESETS[selectedStatus];

  return <div className="loading-preview-page">
    <Navbar />
    <main>
      <section className="loading-preview-hero">
        <div className="container loading-preview-hero__inner">
          <div className="preview-eyebrow"><span className="eyebrow-rule" /> Development preview</div>
          <SectionHeading eyebrow="VeilPool loading system" title={<>A little patience.<br /><em>A lot of privacy.</em></>} copy="A visual review surface for the branded waiting states that will guide confidential operations in Phase 6B." />
          <div className="preview-notice"><CircleHelp size={15} /><span>Visual only — no wallet, contract, transaction, or decryption state is connected.</span></div>
        </div>
      </section>
      <section className="loading-showcase-section">
        <div className="container">
          <div className="showcase-toolbar">
            <div><span className="eyebrow">Status presets</span><p>Choose copy to preview across the system.</p></div>
            <div className="preset-controls" role="group" aria-label="Loading status presets">
              {STATUS_PRESETS.map((preset, index) => <button key={preset.label} className={`preset-button${selectedStatus === index ? " preset-button--active" : ""}`} onClick={() => setSelectedStatus(index)} aria-pressed={selectedStatus === index}>{preset.label}</button>)}
            </div>
          </div>

          <div className="loader-showcase-grid">
            <article className="loader-showcase-card loader-showcase-card--inline">
              <div className="showcase-card-heading"><span>01</span><div><h2>Inline</h2><p>For buttons and small actions.</p></div></div>
              <div className="inline-demo-button"><VeilPoolLoader variant="inline" statusText={status.status} /><span className="inline-demo-arrow">→</span></div>
            </article>

            <article className="loader-showcase-card">
              <div className="showcase-card-heading"><span>02</span><div><h2>Panel</h2><p>For a card or section waiting state.</p></div></div>
              <div className="panel-demo"><VeilPoolLoader variant="panel" statusText={status.status} supportingText={status.supporting} /></div>
            </article>

            <article className="loader-showcase-card loader-showcase-card--overlay">
              <div className="showcase-card-heading"><span>03</span><div><h2>Overlay</h2><p>For important multi-step operations.</p></div></div>
              <div className="overlay-demo"><div className="overlay-demo__base"><div className="overlay-demo__lines" /><span>Private savings</span><strong>••••••••</strong></div><VeilPoolLoader variant="overlay" contained statusText={status.status} supportingText={status.supporting} /></div>
            </article>
          </div>

          <article className="withdrawal-showcase-card">
            <div className="withdrawal-showcase-copy"><span className="eyebrow">04 · Multi-step state</span><h2>Withdrawal, with clarity at every step.</h2><p>The parent controls the active step. Nothing advances automatically, so the UI will reflect real asynchronous protocol progress when connected.</p><div className="withdrawal-preview-controls" role="group" aria-label="Withdrawal step controls"><button onClick={() => setWithdrawalStep((step) => Math.max(0, step - 1))} disabled={withdrawalStep === 0}><ArrowLeft size={14} /> Previous</button><button onClick={() => setWithdrawalStep((step) => Math.min(3, step + 1))} disabled={withdrawalStep === 3}>Next <ArrowLeft className="next-icon" size={14} /></button><button className="reset-button" onClick={() => setWithdrawalStep(0)}><RotateCcw size={13} /> Reset</button></div></div>
            <div className="withdrawal-progress-stage"><WithdrawalProgress currentStep={withdrawalStep} /><div className="withdrawal-stage-note"><ShieldCheck size={14} /> Status text stays visible with reduced motion.</div></div>
          </article>
        </div>
      </section>
    </main>
    <footer className="loading-preview-footer"><div className="container"><Button href="/" variant="ghost"><ArrowLeft size={15} /> Back to landing page</Button><span><LockKeyhole size={13} /> Development-only preview</span></div></footer>
  </div>;
}
