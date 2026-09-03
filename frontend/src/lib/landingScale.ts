export const LANDING_DESIGN_WIDTH = 1280;
export const LANDING_SCALE_BREAKPOINT = 820;

export function getLandingScale(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || viewportWidth > LANDING_SCALE_BREAKPOINT) {
    return 1;
  }

  return Math.min(1, viewportWidth / LANDING_DESIGN_WIDTH);
}

export function getScaledLandingHeight(naturalHeight: number, viewportWidth: number): number {
  if (!Number.isFinite(naturalHeight) || naturalHeight < 0) return 0;
  return naturalHeight * getLandingScale(viewportWidth);
}
