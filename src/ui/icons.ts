/**
 * 道具バーのアイコン（線と塗りだけの小さなSVG）。フォントに頼らないのでどのiPadでも同じ見た目になる。
 * どれも 24×24 で、色は currentColor。
 */

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const head = (filled: boolean, cx = 9.5, cy = 17.5) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="3.6" ry="2.6" transform="rotate(-20 ${cx} ${cy})" ${filled ? 'fill="currentColor"' : ''}/>`;
const stem = '<path d="M12.9 16.6V3.5"/>';
const flag1 = '<path d="M12.9 3.5c.4 3 4.6 3.6 4.4 8"/>';
const flag2 = '<path d="M12.9 7.5c.4 3 4.6 3.6 4.4 8"/>';

export const ICONS = {
  w: svg('<ellipse cx="12" cy="12" rx="6.2" ry="4.2" stroke-width="2"/><ellipse cx="12" cy="12" rx="1.9" ry="3.4" transform="rotate(35 12 12)" fill="currentColor" stroke="none"/>'),
  h: svg(head(false) + stem),
  q: svg(head(true) + stem),
  '8': svg(head(true) + stem + flag1),
  '16': svg(head(true) + stem + flag1 + flag2),
  dot: svg(head(true, 8.5) + '<path d="M11.9 16.6V3.5"/><circle cx="17.5" cy="16.5" r="1.7" fill="currentColor" stroke="none"/>'),
  rest: svg('<path d="M9.5 3.5l4.6 5.2-3.4 4 4.4 5.1c-2.6-1.4-5.4-.6-3.4 2.8" stroke-width="2.1"/>'),
  tie: svg(head(true, 6, 15) + head(true, 18, 15) + '<path d="M5 10.5q7-5 14 0"/>'),
  tuplet: svg('<path d="M3.5 7.5V5h17v2.5"/><text x="12" y="8.2" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-weight="700">3</text>'
    + '<path d="M6.5 19.5v-9M12 19.5v-9M17.5 19.5v-9M6.5 10.5h11"/><circle cx="5" cy="19.7" r="1.9" fill="currentColor" stroke="none"/><circle cx="10.5" cy="19.7" r="1.9" fill="currentColor" stroke="none"/><circle cx="16" cy="19.7" r="1.9" fill="currentColor" stroke="none"/>'),
  chord: svg(head(true, 9.5, 18.5) + head(true, 9.5, 12.5) + '<path d="M12.9 17.6V3.5"/>'),
  back: svg('<path d="M9 5h11v14H9l-6-7z"/><path d="M12.5 9.5l5 5m0-5l-5 5"/>'),
  up: svg('<path d="M6 14l6-6 6 6"/>'),
  down: svg('<path d="M6 10l6 6 6-6"/>'),
  left: svg('<path d="M14 6l-6 6 6 6"/>'),
  right: svg('<path d="M10 6l6 6-6 6"/>'),
  trash: svg('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 10.5v6.5M14 10.5v6.5"/>'),
  range: svg('<path d="M7 4H4v16h3M17 4h3v16h-3"/><path d="M9 9h6M9 12h6M9 15h6" stroke-dasharray="1.5 2"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="11" height="12" rx="1.5"/><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 5v10A1.5 1.5 0 0 0 6 16.5h2.5"/>'),
  cut: svg('<circle cx="6.5" cy="17.5" r="2.8"/><circle cx="17.5" cy="17.5" r="2.8"/><path d="M8.5 15.5L18 3.5M15.5 15.5L6 3.5"/>'),
  paste: svg('<path d="M9 4.5H6.5A1.5 1.5 0 0 0 5 6v13.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H15"/><rect x="9" y="3" width="6" height="3.5" rx="1"/><path d="M9 12h6M9 15.5h4"/>'),
  measure: svg('<path d="M3 7h18M3 10h18M3 13h18M3 16h18M8 5.5v12M16 5.5v12"/>'),
  select: svg('<path d="M6 3.5l11.5 8.2-5.2 1 3 6-2.4 1.2-3-6-3.9 3.6z" fill="currentColor" fill-opacity=".15"/>'),
  input: svg('<path d="M4 20l1-4.5L15.5 5a2 2 0 0 1 3 3L8 18.5z"/><path d="M13.5 7l3 3"/>'),
  pen: svg('<path d="M3 17c3-4 4.5-6 6-4.5s-1 4.5 1.2 4.6c2.2.1 3.5-5.6 6-5.6 1.8 0 1.5 3 3.8 3"/><path d="M15 3.5l3 3"/>'),
  keyboard: svg('<rect x="2.5" y="5" width="19" height="14" rx="1.5"/><path d="M7.25 5v14M12 5v14M16.75 5v14"/><path d="M5.5 5v7.5h3V5M10.5 5v7.5h3V5M15.5 5v7.5h3V5" fill="currentColor" stroke="none"/>'),
  play: svg('<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>'),
  rewind: svg('<path d="M6 5v14"/><path d="M19 5.5v13L8.5 12z" fill="currentColor"/>'),
  soundOn: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" fill-opacity=".15"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>'),
  soundOff: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" fill-opacity=".15"/><path d="M16 9.5l5 5m0-5l-5 5"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  menu: svg('<path d="M4 6.5h16M4 12h16M4 17.5h16"/>'),
  share: svg('<path d="M12 15V3.5M7.5 8L12 3.5 16.5 8"/><path d="M5 12v7.5h14V12"/>'),
  zoomIn: svg('<path d="M12 5v14M5 12h14"/>'),
  zoomOut: svg('<path d="M5 12h14"/>'),
  tempo: svg(head(true, 7, 17.5) + '<path d="M10.4 16.6V4.5"/><path d="M14 11h6M14 15h6"/>'),
  finger: svg('<path d="M9 11V5a1.5 1.5 0 0 1 3 0v5.5"/><path d="M12 10V8.5a1.5 1.5 0 0 1 3 0V11"/><path d="M15 10.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.8-2.4L4.3 15.5a1.5 1.5 0 0 1 2.3-1.9L9 16"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  importPdf: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M12 10v7M9 14l3 3 3-3"/>'),
} as const;

export type IconName = keyof typeof ICONS;

/** `data-icon="名前"` を持つ要素の先頭にアイコンを入れる */
export function applyIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const name = el.dataset.icon as IconName;
    if (!ICONS[name] || el.querySelector(':scope > svg')) return;
    el.insertAdjacentHTML('afterbegin', ICONS[name]);
  });
}

/** 要素のアイコンを差し替える（再生⇔停止など） */
export function setIcon(el: HTMLElement, name: IconName) {
  el.querySelector(':scope > svg')?.remove();
  el.dataset.icon = name;
  el.insertAdjacentHTML('afterbegin', ICONS[name]);
}
