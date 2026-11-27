/**
 * 画面用の描画。段（システム）ごとに別の SVG に描き、変わった段だけを描き直す。
 * 長い曲で1音入れるたびに楽譜全体を描き直すと重いため（200小節の大譜表で1打鍵0.3秒ほどかかっていた）。
 *
 * 段を描き直すかどうかは「その段の見た目を決めるもの」を文字列にしたキーで判断する：
 * - 曲全体：タイトル・テンポ・拍子・調号・小節ごとの記号など、パートの音符以外すべてと、描く幅・倍率
 * - 段：その段の小節の中身と、前後の小節の端の音（段をまたぐタイのため）、段の小節の並びと幅、
 *   段にかかるスラー・ヘアピン、段の中の選択・範囲・入力位置・入力中の文字
 * PDF書き出しは今までどおり renderPage でページごとに描く。
 */
import { resolveSpanners } from '../model/marks';
import { Score, measureEvents, voiceEvents } from '../model/score';
import { partSpacing } from './texts';
import {
  MeasureHit, RenderOptions, RenderResult, SystemLayout, TITLE_HEIGHT, layoutSystems, renderPage, systemHeight,
} from './render';

/** renderScore と同じ上の余白 */
const TOP = 20;
/** 2段目以降を描くときの、SVG の中の上の余白（五線より上にはみ出す音符・記号の分） */
const PAD = 60;

interface SystemSlot {
  key: string;
  el: HTMLDivElement;
  /** 楽譜全体の座標に直した当たり判定 */
  result: RenderResult;
}

/** 当たり判定の Y を dy だけずらす（段ごとの SVG の座標 → 楽譜全体の座標） */
function shiftResult(r: RenderResult, dy: number): RenderResult {
  if (!dy) return r;
  const hits: MeasureHit[] = r.hits.map((h) => {
    const voices = h.voices.map((list) => list.map((e) => ({ ...e, headYs: e.headYs.map((y) => y + dy) })));
    return { ...h, topLineY: h.topLineY + dy, voices, events: voices[0] };
  });
  return {
    hits,
    tempoHits: r.tempoHits.map((t) => ({ ...t, y: t.y + dy })),
    textHits: r.textHits.map((t) => ({ ...t, y: t.y + dy })),
    height: r.height,
  };
}

export class ScoreView {
  private root: HTMLDivElement | null = null;
  private globalKey = '';
  private slots: SystemSlot[] = [];
  /** 直前の描画で描き直した段の数（テスト・計測用） */
  lastRedrawn = 0;

  constructor(private host: HTMLElement) {}

  /** 描き直しの覚えを捨てる（次の render ですべて描く） */
  invalidate() {
    this.globalKey = '';
  }

  render(score: Score, opts: RenderOptions): RenderResult {
    const scale = opts.scale ?? 1;
    if (!this.root || this.root.parentElement !== this.host) {
      this.root = document.createElement('div');
      this.root.className = 'score-systems';
      this.root.style.position = 'relative';
      this.host.prepend(this.root);
      this.slots = [];
    }
    const systems = layoutSystems(score, opts);
    const sysH = systemHeight(score);
    const n = score.parts[0].measures.length;

    const { parts, spanners, createdAt, updatedAt, ...rest } = score;
    void spanners; void createdAt; void updatedAt;
    const globalKey = JSON.stringify({
      rest,
      clefs: parts.map((p) => p.clef),
      n,
      spacing: partSpacing(score),
      width: opts.width,
      scale,
      drawTitle: opts.drawTitle,
    });
    if (globalKey !== this.globalKey) {
      this.globalKey = globalKey;
      for (const s of this.slots) s.el.remove();
      this.slots = [];
    }

    const spans = resolveSpanners(score);
    let redrawn = 0;
    const results: RenderResult[] = [];
    systems.forEach((sys, si) => {
      const key = this.systemKey(score, sys, si, opts, spans);
      let slot = this.slots[si];
      if (!slot || slot.key !== key) {
        const el = slot?.el ?? document.createElement('div');
        if (!slot) {
          el.className = 'score-system';
          el.style.position = 'absolute';
          el.style.left = '0';
          this.root!.appendChild(el);
        }
        const first = si === 0;
        // 段の上端（楽譜全体の座標）と、その段の SVG の中での上端
        const absTop = TOP + TITLE_HEIGHT + si * sysH;
        const localTop = first ? TOP + TITLE_HEIGHT : PAD;
        const dy = absTop - localTop;
        const res = renderPage(el, score, { systems: [sys], first }, opts, 0, first ? TOP : PAD);
        el.style.top = dy * scale + 'px';
        slot = { key, el, result: shiftResult(res, dy) };
        this.slots[si] = slot;
        redrawn++;
      }
      results.push(slot.result);
    });
    for (const s of this.slots.splice(systems.length)) s.el.remove();
    this.lastRedrawn = redrawn;

    const height = TOP + TITLE_HEIGHT + systems.length * sysH + 20;
    this.root.style.width = opts.width * scale + 'px';
    this.root.style.height = height * scale + 'px';
    return {
      hits: results.flatMap((r) => r.hits),
      tempoHits: results.flatMap((r) => r.tempoHits),
      textHits: results.flatMap((r) => r.textHits),
      height,
    };
  }

  private systemKey(
    score: Score, sys: SystemLayout, si: number, opts: RenderOptions, spans: ReturnType<typeof resolveSpanners>,
  ): string {
    const first = sys.measures[0];
    const last = sys.measures[sys.measures.length - 1];
    const inSys = (mi: number) => mi >= first && mi <= last;
    const ids = new Set<string>();
    for (const p of score.parts) for (const mi of sys.measures) for (const ev of measureEvents(p.measures[mi])) ids.add(ev.id);
    const c = opts.cursor;
    const f = opts.textFocus;
    const focusHere = !!f && (f.eventId ? ids.has(f.eventId) : f.measureIndex !== undefined && inSys(f.measureIndex));
    return JSON.stringify({
      si: si === 0,
      measures: sys.measures,
      widths: sys.widths,
      data: score.parts.map((p) => p.measures.slice(first, last + 1)),
      // 隣の小節は、段をまたぐタイに関わる音（前の小節の最後の音・次の小節の最初の音）だけ
      edges: score.parts.map((p) => [0, 1].map((v) => {
        const prev = p.measures[first - 1] ? voiceEvents(p.measures[first - 1], v) : [];
        const next = p.measures[last + 1] ? voiceEvents(p.measures[last + 1], v) : [];
        return [prev[prev.length - 1] ?? null, next[0] ?? null];
      })),
      spans: spans
        .filter((r) => r.from.loc.measureIndex <= last && r.to.loc.measureIndex >= first)
        .map((r) => [
          r.spanner.kind, r.spanner.from, r.spanner.to, r.from.loc.measureIndex, r.to.loc.measureIndex,
          !!score.parts[r.partIndex].measures[r.from.loc.measureIndex]?.voice2,
          !!score.parts[r.partIndex].measures[r.to.loc.measureIndex]?.voice2,
        ]),
      sel: opts.selectedId && ids.has(opts.selectedId) ? [opts.selectedId, opts.selectedPitchIndex] : null,
      range: opts.rangeIds ? [...opts.rangeIds].filter((id) => ids.has(id)) : [],
      cursor: c && inSys(c.measureIndex) ? c : null,
      focus: focusHere ? f : null,
    });
  }
}
