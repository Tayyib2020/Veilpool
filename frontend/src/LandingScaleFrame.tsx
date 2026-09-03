import { PropsWithChildren, useLayoutEffect, useRef } from "react";
import { getLandingScale, getScaledLandingHeight, LANDING_DESIGN_WIDTH, LANDING_SCALE_BREAKPOINT } from "./lib/landingScale";

export default function LandingScaleFrame({ children }: PropsWithChildren) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;

    let animationFrame = 0;
    const measure = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
        const scale = getLandingScale(viewportWidth);
        const scaled = viewportWidth <= LANDING_SCALE_BREAKPOINT;

        frame.dataset.scaled = String(scaled);
        canvas.style.width = scaled ? `${LANDING_DESIGN_WIDTH}px` : "100%";
        canvas.style.transform = scaled ? `scale(${scale})` : "none";
        frame.style.height = scaled ? `${getScaledLandingHeight(canvas.scrollHeight, viewportWidth)}px` : "";
      });
    };

    measure();
    window.addEventListener("resize", measure, { passive: true });
    window.addEventListener("orientationchange", measure, { passive: true });

    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(canvas);
    void document.fonts?.ready.then(measure);

    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      observer?.disconnect();
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  return <div ref={frameRef} className="landing-scale-frame" data-landing-scale-frame>
    <div ref={canvasRef} className="landing-scale-canvas">{children}</div>
  </div>;
}
