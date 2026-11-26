/**
 * MusicXML（score-partwise）→ Score。
 * Audiveris などの楽譜読み取り（OMR）ソフトや MuseScore の書き出しを、この形で受け取る。
 *
 * この楽譜の形に合わせて単純化する:
 * - 1つの段（staff）につき声部は1つ（最初に出てきた声部）。ほかの声部は捨てる
 * - ピアノなど2段のパートは、段ごとに別のパートにする
 * - 拍子は最初のものだけ（途中で変わったら、最初の拍子で小節を引き直す）
 * - 連符・装飾音は近い長さに丸める／捨てる
 */
import { PPQ } from '../model/duration';
import { Pitch, STEPS, Step } from '../model/pitch';
import {
  Clef, Part, SCHEMA_VERSION, Score, TempoMark, TimeSignature, equalizeMeasureCounts, measureCapacity, uid,
} from '../model/score';
import { TimedEvent, buildMeasures } from './timeline';

export interface ImportResult {
  score: Score;
  /** 利用者に伝える注意（丸めた・捨てたなど） */
  warnings: string[];
}

const kids = (el: Element, name?: string) =>
  Array.from(el.children).filter((c) => !name || c.localName === name);
const kid = (el: Element | null | undefined, name: string) => (el ? kids(el, name)[0] ?? null : null);
const txt = (el: Element | null | undefined, name: string) => kid(el, name)?.textContent?.trim() ?? '';
const num = (el: Element | null | undefined, name: string, fallback = 0) => {
  const v = parseFloat(txt(el, name));
  return Number.isFinite(v) ? v : fallback;
};

function clefOf(el: Element): Clef {
  const sign = txt(el, 'sign').toUpperCase();
  const line = num(el, 'line', 0);
  if (sign === 'F') return 'bass';
  if (sign === 'C' && (line === 3 || line === 0)) return 'alto';
  return 'treble';
}

interface StaffState {
  events: TimedEvent[];
  voice: string | null;
  clef: Clef | null;
  /** 和音の続きを足すために、直前に置いた音 */
  last: TimedEvent | null;
}

export function parseMusicXml(xml: string): ImportResult {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('MusicXML として読めませんでした');
  const root = doc.documentElement;
  if (root.localName === 'score-timewise') throw new Error('score-timewise 形式の MusicXML にはまだ対応していません');
  if (root.localName !== 'score-partwise') throw new Error('MusicXML の楽譜ではありません');

  const warn = new Set<string>();
  const title = txt(kid(root, 'work'), 'work-title') || txt(root, 'movement-title') || '取り込んだ楽譜';
  const composer = kids(kid(root, 'identification') ?? root, 'creator')
    .find((c) => (c.getAttribute('type') ?? 'composer') === 'composer')?.textContent?.trim() ?? '';

  const partNames = new Map<string, string>();
  for (const sp of kids(kid(root, 'part-list') ?? root, 'score-part')) {
    partNames.set(sp.getAttribute('id') ?? '', txt(sp, 'part-name'));
  }

  let timeSignature: TimeSignature | null = null;
  let keyFifths: number | null = null;
  const tempos: { tick: number; tempo: number }[] = [];
  let pickup = 0;
  const outParts: { name: string; staff: StaffState }[] = [];

  for (const partEl of kids(root, 'part')) {
    const baseName = partNames.get(partEl.getAttribute('id') ?? '') ?? '';
    const staves = new Map<number, StaffState>();
    const staffOf = (n: number) => {
      let s = staves.get(n);
      if (!s) staves.set(n, (s = { events: [], voice: null, clef: null, last: null }));
      return s;
    };
    let staffCount = 1;
    let divisions = 1;
    let measureStart = 0;
    const measures = kids(partEl, 'measure');

    measures.forEach((mEl, mi) => {
      let pos = 0;
      let maxPos = 0;
      for (const c of kids(mEl)) {
        switch (c.localName) {
          case 'attributes': {
            if (kid(c, 'divisions')) divisions = num(c, 'divisions', 1) || 1;
            if (kid(c, 'staves')) staffCount = Math.max(staffCount, num(c, 'staves', 1));
            const key = kid(c, 'key');
            if (key && kid(key, 'fifths')) {
              const f = Math.max(-7, Math.min(7, Math.round(num(key, 'fifths'))));
              if (keyFifths === null) keyFifths = f;
              else if (f !== keyFifths) warn.add('途中の調号の変更は反映していません（最初の調号のままです）');
            }
            const time = kid(c, 'time');
            if (time && kid(time, 'beats')) {
              const ts = { beats: Math.round(num(time, 'beats', 4)) || 4, beatType: Math.round(num(time, 'beat-type', 4)) || 4 };
              if (!timeSignature) timeSignature = ts;
              else if (ts.beats !== timeSignature.beats || ts.beatType !== timeSignature.beatType) {
                warn.add('途中の拍子の変更は反映していません（最初の拍子で小節を区切り直しました）');
              }
            }
            for (const cl of kids(c, 'clef')) {
              const st = staffOf(parseInt(cl.getAttribute('number') ?? '1', 10) || 1);
              st.clef ??= clefOf(cl);
            }
            break;
          }
          case 'backup':
            pos -= (num(c, 'duration') * PPQ) / divisions;
            if (pos < 0) pos = 0;
            break;
          case 'forward':
            pos += (num(c, 'duration') * PPQ) / divisions;
            break;
          case 'direction':
          case 'sound': {
            const sounds = c.localName === 'sound' ? [c] : Array.from(c.getElementsByTagName('sound'));
            let tempo = sounds.map((s) => parseFloat(s.getAttribute('tempo') ?? '')).find((t) => t > 0);
            if (!tempo) {
              const met = c.getElementsByTagName('metronome')[0];
              const unit = txt(met, 'beat-unit');
              const per = num(met, 'per-minute');
              const unitQ: Record<string, number> = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25 };
              if (met && per > 0 && unitQ[unit]) {
                tempo = per * unitQ[unit] * (kid(met, 'beat-unit-dot') ? 1.5 : 1);
              }
            }
            if (tempo && outParts.length === 0) tempos.push({ tick: measureStart + pos, tempo: Math.round(tempo) });
            break;
          }
          case 'note': {
            if (kid(c, 'grace')) { warn.add('装飾音は取り込んでいません'); break; }
            if (kid(c, 'cue')) break;
            const dur = (num(c, 'duration') * PPQ) / divisions;
            const st = staffOf(parseInt(txt(c, 'staff') || '1', 10) || 1);
            const voice = txt(c, 'voice') || '1';
            const isChord = !!kid(c, 'chord');
            const pitchEl = kid(c, 'pitch');
            const tie = kids(c, 'tie').some((t) => t.getAttribute('type') === 'start')
              || Array.from(c.getElementsByTagName('tied')).some((t) => t.getAttribute('type') === 'start');
            if (kid(c, 'time-modification')) warn.add('連符は近い長さの音符に置き換えました');

            if (isChord) {
              // 和音の2音目以降：直前の音に重ねる（時刻は進めない）
              if (pitchEl && st.voice === voice && st.last?.pitches) {
                st.last.pitches.push(readPitch(pitchEl));
                if (tie) st.last.tie = true;
              }
              break;
            }
            st.voice ??= voice;
            if (voice !== st.voice) {
              warn.add('1つの段に複数の声部がある所は、最初の声部だけを取り込みました');
              pos += dur;
              maxPos = Math.max(maxPos, pos);
              break;
            }
            const ev: TimedEvent = {
              start: measureStart + pos,
              ticks: dur,
              pitches: pitchEl ? [readPitch(pitchEl)] : null,
              tie: !!pitchEl && tie,
            };
            if (kid(c, 'unpitched')) ev.pitches = null;
            st.events.push(ev);
            st.last = ev;
            pos += dur;
            break;
          }
        }
        maxPos = Math.max(maxPos, pos);
      }
      const cap = measureCapacity(timeSignature ?? { beats: 4, beatType: 4 });
      let len = Math.max(maxPos, cap);
      if (mEl.getAttribute('implicit') === 'yes' && maxPos > 0 && maxPos < cap) {
        len = maxPos;
        if (mi === 0 && outParts.length === 0) pickup = cap - maxPos;
      }
      measureStart += len;
    });

    const nums = [...new Set([...staves.keys(), ...Array.from({ length: staffCount }, (_, i) => i + 1)])].sort((a, b) => a - b);
    const piano = /piano|pf|ピアノ|klavier/i.test(baseName);
    nums.forEach((n, i) => {
      let name = baseName || `パート${outParts.length + 1}`;
      if (nums.length === 2 && piano) name = i === 0 ? '右手' : '左手';
      else if (nums.length > 1) name = `${name} ${i + 1}段目`;
      outParts.push({ name, staff: staffOf(n) });
    });
  }

  if (!outParts.length) throw new Error('パート（五線）が見つかりませんでした');
  const ts: TimeSignature = timeSignature ?? { beats: 4, beatType: 4 };
  const cap = measureCapacity(ts);
  let quantized = false;
  let dropped = false;

  const parts: Part[] = outParts.map(({ name, staff }, i) => {
    const events = staff.events.map((e) => ({ ...e, start: e.start + pickup }));
    const built = buildMeasures(events, cap);
    quantized ||= built.quantized;
    dropped ||= built.droppedOverlap;
    return {
      id: uid(),
      name,
      clef: staff.clef ?? (i > 0 && outParts.length === 2 ? 'bass' : 'treble'),
      instrument: 'piano',
      measures: built.measures,
    };
  });
  if (quantized) warn.add('細かいリズム（連符など）は近い長さに丸めました');
  if (dropped) warn.add('重なっていた音の一部を省きました');

  const sortedTempos = tempos.map((t) => ({ measure: Math.floor((t.tick + pickup) / cap), tempo: t.tempo }));
  const tempo = sortedTempos.find((t) => t.measure === 0)?.tempo ?? sortedTempos[0]?.tempo ?? 100;
  const marks = new Map<number, number>();
  for (const t of sortedTempos) if (t.measure > 0) marks.set(t.measure, t.tempo);
  const tempoMarks: TempoMark[] = [...marks].sort((a, b) => a[0] - b[0])
    .filter(([, t], i, arr) => t !== (i === 0 ? tempo : arr[i - 1][1]))
    .map(([measure, t]) => ({ measure, tempo: t }));

  const now = Date.now();
  const score: Score = {
    schemaVersion: SCHEMA_VERSION,
    id: uid(),
    title,
    composer,
    tempo,
    timeSignature: ts,
    keyFifths: keyFifths ?? 0,
    parts,
    createdAt: now,
    updatedAt: now,
  };
  if (tempoMarks.length) score.tempoMarks = tempoMarks;
  equalizeMeasureCounts(score);
  return { score, warnings: [...warn] };
}

function readPitch(el: Element): Pitch {
  const s = txt(el, 'step').toUpperCase() as Step;
  return {
    step: STEPS.includes(s) ? s : 'C',
    alter: Math.max(-2, Math.min(2, Math.round(num(el, 'alter')))),
    octave: Math.round(num(el, 'octave', 4)),
  };
}
