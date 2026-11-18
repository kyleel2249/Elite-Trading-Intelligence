import { withChartView } from "./chartview.ts";
import { withFvgLayer } from "./fvg-layer.ts";
import { withIndicatorOverlay } from "./indicator-overlay.ts";
import { withSmcLayer } from "./smc-layer.ts";
import { withExtremeForecastLayer } from "./extreme-forecast.ts";
import { withPwa } from "./pwa.ts";

/**
 * Static dashboard presentation layer.
 * No 3D transforms, tilt, parallax, animated backgrounds, entrance effects,
 * or number-flash animations. Data, controls and analysis layers are untouched.
 */
export const MOTION_CSS = `<style id="eti-motion">
html{background:#080d16;overflow-x:clip}
body{overflow-x:clip;background:transparent!important}
main{width:100%;max-width:none;margin:0;padding:22px clamp(12px,2vw,32px)}
.panel{min-width:0;backdrop-filter:none;-webkit-backdrop-filter:none;transform:none!important;transition:none!important;box-shadow:0 8px 24px rgba(0,0,0,.22)}
.panel::before{content:none!important}
.panel h2{letter-spacing:.2px;text-shadow:none}
.panel>h2,.panel>.meta{transform:none!important}
button{transition:none!important}
button:hover:not(:disabled),button:active:not(:disabled){transform:none!important;filter:none;box-shadow:none}
button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid #5aa9ff;outline-offset:2px}
@media(max-width:700px){main{padding:14px 10px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
</style>`;

export const MOTION_JS = "";

export function withMotion(page: string): string {
  return withPwa(withExtremeForecastLayer(withSmcLayer(withIndicatorOverlay(withFvgLayer(withChartView(page.replace("</head>", MOTION_CSS + "</head>")))))));
}
