/**
 * MusicXML（score-partwise）→ Score。
 * Audiveris などの楽譜読み取り（OMR）ソフトや MuseScore の書き出しを、この形で受け取る。
 *
 * この楽譜の形に合わせて単純化する:
 * - 1つの段（staff）につき声部は2つまで（最初に出てきた声部を声部1、次を声部2）。3つ目からは捨てる
 * - ピアノなど2段のパートは、段ごとに別のパートにする
 * - 途中の調号・拍子の変更、リピート記号、番号付きカッコ（ending）、弱起（1小節目の implicit）は取り込む
 * - 連符はそのまま取り込む（入れ子の連符や、ティックが割り切れない7連符などは近い長さに丸める）
 * - 装飾音、途中の音部記号の変更、オクターブ記号、ペダル、セーニョ・コーダ・Fine・D.C./D.S. も取り込む
 */
import { DurationType, PPQ, ticksOf } from '../model/duration';
import { Pitch, STEPS, Step, comparePitch } from '../model/pitch';
import {
  Clef, GraceNote, JumpKind, Part, SCHEMA_VERSION, Score, TempoMark, TimeSignature, VOICE_COUNT, equalizeMeasureCounts, measureCapacity,
  normalizeMeasure, uid, MeasureAttrs,
} from '../model/score';
import { Bars, TimedEvent, buildMeasures } from './timeline';
import { EventTexts } from '../model/score';
import { KIND_SUFFIX, MAX_VERSES } from '../model/texts';
import { MarkState, newMarkState, readDirectionMarks, readNoteMarks, resolveImportedSpanners } from './musicxml-marks';

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

interface VoiceState {
  events: TimedEvent[];
  /** 和音の続きを足すために、直前に置いた音 */
  last: TimedEvent | null;
  /** 読んでいる途中の連符 */
  tup: { key: string; actual: number; normal: number; filled: number; full: number } | null;
}

interface StaffState {
  /** MusicXML の声部番号 → この楽譜の声部（出てきた順。2つまで） */
  voices: Map<string, VoiceState>;
  clef: Clef | null;
  /** 途中の音部記号の変更（曲頭からのティック） */
  clefChanges: { tick: number; clef: Clef }[];
  /** 声部ごとの、次の音符に付ける装飾音 */
  graces: Map<string, GraceNote[]>;
  /** 直前に置いた音（声部を問わない）。強弱記号などを付ける先 */
  last: TimedEvent | null;
  /** スラー・強弱記号など（musicxml-marks.ts） */
  marks: MarkState;
  /** 次の音符・休符に付けるコードネーム・文字 */
  pending: EventTexts;
}

const ACC_TEXT = (a: number) => (a > 0 ? '#'.repeat(a) : a < 0 ? 'b'.repeat(-a) : '');

/** <harmony> → "F#m7/C#" のような文字 */
function readHarmony(el: Element): string {
  const root = kid(el, 'root');
  if (!root) return '';
  const kindEl = kid(el, 'kind');
  const kind = kindEl?.textContent?.trim() ?? 'major';
  const suffix = kindEl?.getAttribute('text') ?? KIND_SUFFIX[kind] ?? '';
  const bass = kid(el, 'bass');
  return txt(root, 'root-step') + ACC_TEXT(Math.round(num(root, 'root-alter'))) + suffix
    + (bass ? '/' + txt(bass, 'bass-step') + ACC_TEXT(Math.round(num(bass, 'bass-alter'))) : '');
}

/** <lyric> の並び → 番ごとの音節（つながる音節は末尾に '-'） */
function readLyrics(note: Element): string[] | undefined {
  const out: string[] = [];
  kids(note, 'lyric').forEach((l, i) => {
    const n = parseInt(l.getAttribute('number') ?? '', 10);
    const v = Number.isFinite(n) && n >= 1 ? n - 1 : i;
    if (v >= MAX_VERSES) return;
    const text = kids(l, 'text').map((t) => t.textContent ?? '').join('').trim();
    if (!text) return;
    const syl = txt(l, 'syllabic');
    while (out.length < v) out.push('');
    out[v] = text + (syl === 'begin' || syl === 'middle' ? '-' : '');
  });
  return out.length ? out : undefined;
}

const TYPES: Record<string, DurationType> = {
  whole: 'w', half: 'h', quarter: 'q', eighth: '8', '16th': '16', '32nd': '32',
};

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
  const rehearsals: { tick: number; text: string }[] = [];
  let pickup = 0;
  /** 最初のパートから読んだ、小節ごとの長さと記号 */
  const caps: number[] = [];
  const attrs = new Map<number, MeasureAttrs>();
  const attrOf = (mi: number) => {
    let a = attrs.get(mi);
    if (!a) attrs.set(mi, (a = { measure: mi }));
    return a;
  };
  const outParts: { name: string; staff: StaffState }[] = [];

  for (const partEl of kids(root, 'part')) {
    const baseName = partNames.get(partEl.getAttribute('id') ?? '') ?? '';
    const staves = new Map<number, StaffState>();
    const staffOf = (n: number) => {
      let s = staves.get(n);
      if (!s) staves.set(n, (s = { voices: new Map(), clef: null, clefChanges: [], graces: new Map(), last: null, marks: newMarkState(), pending: {} }));
      return s;
    };
    let staffCount = 1;
    let divisions = 1;
    let measureStart = 0;
    const measures = kids(partEl, 'measure');
    const first = outParts.length === 0;
    let curTs: TimeSignature | null = null;
    let curKey: number | null = null;
    let openVolta: number[] | null = null;

    measures.forEach((mEl, mi) => {
      let pos = 0;
      let maxPos = 0;
      let closeVolta = false;
      for (const c of kids(mEl)) {
        switch (c.localName) {
          case 'barline': {
            if (!first) break;
            const rep = kid(c, 'repeat');
            if (rep?.getAttribute('direction') === 'forward') attrOf(mi).repeatStart = true;
            if (rep?.getAttribute('direction') === 'backward') {
              attrOf(mi).repeatEnd = true;
              const times = parseInt(rep.getAttribute('times') ?? '', 10);
              if (times > 2) attrOf(mi).repeatTimes = times;
            }
            const end = kid(c, 'ending');
            if (end) {
              const type = end.getAttribute('type');
              if (type === 'start') {
                const nums = (end.getAttribute('number') ?? '1').split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((x) => x > 0);
                openVolta = nums.length ? nums : [1];
              } else if (type === 'stop' || type === 'discontinue') closeVolta = true;
            }
            break;
          }
          case 'attributes': {
            if (kid(c, 'divisions')) divisions = num(c, 'divisions', 1) || 1;
            if (kid(c, 'staves')) staffCount = Math.max(staffCount, num(c, 'staves', 1));
            const key = kid(c, 'key');
            if (key && kid(key, 'fifths')) {
              const f = Math.max(-7, Math.min(7, Math.round(num(key, 'fifths'))));
              if (first) {
                if (keyFifths === null) keyFifths = f;
                else if (f !== curKey) attrOf(mi).keyFifths = f;
              }
              curKey = f;
            }
            const time = kid(c, 'time');
            if (time && kid(time, 'beats')) {
              const ts = { beats: Math.round(num(time, 'beats', 4)) || 4, beatType: Math.round(num(time, 'beat-type', 4)) || 4 };
              if (first) {
                if (!timeSignature) timeSignature = ts;
                else if (!curTs || ts.beats !== curTs.beats || ts.beatType !== curTs.beatType) attrOf(mi).timeSignature = ts;
              }
              curTs = ts;
            }
            for (const cl of kids(c, 'clef')) {
              const st = staffOf(parseInt(cl.getAttribute('number') ?? '1', 10) || 1);
              const clef = clefOf(cl);
              if (!st.clef) st.clef = clef;
              else st.clefChanges.push({ tick: measureStart + pos, clef });
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
          case 'harmony': {
            const chord = readHarmony(c);
            if (chord) staffOf(parseInt(txt(c, 'staff') || '1', 10) || 1).pending.chord = chord;
            break;
          }
          // 下の case 'sound' へそのまま続けて、テンポも読む
          case 'direction': {
            const st = staffOf(parseInt(txt(c, 'staff') || '1', 10) || 1);
            for (const dt of kids(c, 'direction-type')) {
              for (const r of kids(dt, 'rehearsal')) {
                const t = r.textContent?.trim();
                if (t && outParts.length === 0) rehearsals.push({ tick: measureStart + pos, text: t });
              }
              if (first && kids(dt, 'segno').length) attrOf(mi).segno = true;
              if (first && kids(dt, 'coda').length) attrOf(mi).coda = true;
              let words = kids(dt, 'words').map((w) => w.textContent?.trim() ?? '').filter(Boolean).join(' ');
              // D.S. al Coda・Fine・To Coda などは文字ではなく小節の記号にする
              const flow = readFlowWords(words);
              if (flow) {
                if (first) Object.assign(attrOf(mi), flow);
                words = '';
              }
              if (words) st.pending.text = st.pending.text ? `${st.pending.text} ${words}` : words;
            }
          }
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
            if (c.localName === 'direction') {
              const st = staffOf(parseInt(txt(c, 'staff') || '1', 10) || 1);
              readDirectionMarks(c, st.marks, st.last);
            }
            break;
          }
          case 'note': {
            if (kid(c, 'cue')) break;
            const graceEl = kid(c, 'grace');
            if (graceEl) {
              // 装飾音：同じ声部の次の音符の前に付ける
              const pitchEl = kid(c, 'pitch');
              if (!pitchEl) break;
              const gst = staffOf(parseInt(txt(c, 'staff') || '1', 10) || 1);
              const gv = txt(c, 'voice') || '1';
              const list = gst.graces.get(gv) ?? [];
              const p = readPitch(pitchEl);
              if (kid(c, 'chord') && list.length) list[list.length - 1].pitches.push(p);
              else {
                const t = txt(c, 'type');
                list.push({ pitches: [p], duration: t === '16th' || t === '32nd' ? '16' : '8', ...(graceEl.getAttribute('slash') === 'yes' ? { slash: true } : {}) });
              }
              gst.graces.set(gv, list);
              break;
            }
            const dur = (num(c, 'duration') * PPQ) / divisions;
            const st = staffOf(parseInt(txt(c, 'staff') || '1', 10) || 1);
            const voice = txt(c, 'voice') || '1';
            const isChord = !!kid(c, 'chord');
            const pitchEl = kid(c, 'pitch');
            const tie = kids(c, 'tie').some((t) => t.getAttribute('type') === 'start')
              || Array.from(c.getElementsByTagName('tied')).some((t) => t.getAttribute('type') === 'start');

            const vs = st.voices.get(voice);
            const lyrics = readLyrics(c);
            if (isChord) {
              // 和音の2音目以降：直前の音に重ねる（時刻は進めない）
              if (pitchEl && vs?.last?.pitches) {
                vs.last.pitches.push(readPitch(pitchEl));
                if (tie) vs.last.tie = true;
                if (lyrics && !vs.last.texts?.lyrics) (vs.last.texts ??= {}).lyrics = lyrics;
                readNoteMarks(c, st.marks, vs.last, true, voice);
              }
              break;
            }
            if (!vs && st.voices.size >= VOICE_COUNT) {
              warn.add('1つの段に3つ以上の声部がある所は、最初の2つの声部だけを取り込みました');
              pos += dur;
              maxPos = Math.max(maxPos, pos);
              break;
            }
            const target: VoiceState = vs ?? { events: [], last: null, tup: null };
            if (!vs) st.voices.set(voice, target);
            const ev: TimedEvent = {
              start: measureStart + pos,
              ticks: dur,
              pitches: pitchEl ? [readPitch(pitchEl)] : null,
              tie: !!pitchEl && tie,
            };
            if (kid(c, 'unpitched')) ev.pitches = null;
            const texts: EventTexts = { ...st.pending };
            if (lyrics && ev.pitches) texts.lyrics = lyrics;
            if (texts.chord || texts.text || texts.lyrics) ev.texts = texts;
            st.pending = {};
            readNoteMarks(c, st.marks, ev, false, voice);
            const graces = st.graces.get(voice);
            if (graces?.length) {
              if (ev.pitches) ev.graces = graces.map((g) => ({ ...g, pitches: [...g.pitches].sort(comparePitch) }));
              st.graces.delete(voice);
            }
            readTuplet(c, target, ev);
            target.events.push(ev);
            target.last = ev;
            st.last = ev;
            pos += dur;
            break;
          }
        }
        maxPos = Math.max(maxPos, pos);
      }
      if (first && openVolta) attrOf(mi).volta = openVolta;
      if (closeVolta) openVolta = null;
      const cap = measureCapacity(curTs ?? { beats: 4, beatType: 4 });
      let len = Math.max(maxPos, cap);
      // 1小節目が短い（implicit）なら弱起。途中の短い小節（弱起の残りなど）は休符で埋めて普通の長さにする
      if (mi === 0 && mEl.getAttribute('implicit') === 'yes' && maxPos > 0 && maxPos < cap) {
        len = maxPos;
        if (first) pickup = maxPos;
      }
      if (first) caps[mi] = mi === 0 && pickup ? pickup : cap;
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
  const lastCap = caps[caps.length - 1] ?? measureCapacity(ts);
  const capOf = (i: number) => caps[i] ?? lastCap;
  const bars = new Bars(capOf);
  let quantized = false;
  let dropped = false;

  const parts: Part[] = outParts.map(({ name, staff }, i): Part => {
    // 元の TimedEvent をそのまま渡す（buildMeasures が placed を書き込み、スラーなどの両端に使う）
    const lists = [...staff.voices.values()].map((v) => v.events);
    if (!lists.length) lists.push([]);
    const first = buildMeasures(lists[0], capOf, caps.length);
    const second = lists[1] ? buildMeasures(lists[1], capOf, first.measures.length) : null;
    let measures = first.measures;
    if (second && second.measures.length > measures.length) measures = buildMeasures(lists[0], capOf, second.measures.length).measures;
    for (const b of second ? [first, second] : [first]) {
      quantized ||= b.quantized;
      dropped ||= b.droppedOverlap;
    }
    if (second) {
      measures.forEach((m, k) => {
        const v2 = second.measures[k]?.events;
        if (v2) m.voice2 = v2;
        normalizeMeasure(m, capOf(k));
      });
    }
    const clef = staff.clef ?? (i > 0 && outParts.length === 2 ? 'bass' : 'treble');
    // 途中の音部記号の変更は、その時刻を含む小節の頭に付ける（前と同じなら付けない）
    let cur = clef;
    for (const ch of staff.clefChanges) {
      const mi = bars.indexAt(ch.tick);
      if (mi === 0 || !measures[mi]) continue;
      measures[mi].clef = ch.clef;
    }
    measures.forEach((m, k) => {
      if (!m.clef) return;
      if (k === 0 || m.clef === cur) delete m.clef;
      else cur = m.clef;
    });
    return { id: uid(), name, clef, instrument: 'piano', measures };
  });
  if (quantized) warn.add('細かいリズム（連符など）は近い長さに丸めました');
  if (dropped) warn.add('重なっていた音の一部を省きました');

  const sortedTempos = tempos.map((t) => ({ measure: bars.indexAt(t.tick), tempo: t.tempo }));
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
  if (pickup) score.pickup = pickup;
  const measureAttrs = [...attrs.values()].filter((a) => Object.keys(a).length > 1).sort((a, b) => a.measure - b.measure);
  if (measureAttrs.length) score.measureAttrs = measureAttrs;
  const spanners = outParts.flatMap(({ staff }) => resolveImportedSpanners(staff.marks));
  if (spanners.length) score.spanners = spanners;
  equalizeMeasureCounts(score);
  for (const r of rehearsals) {
    const m = score.parts[0].measures[bars.indexAt(r.tick)];
    if (m && !m.rehearsal) m.rehearsal = r.text;
  }
  return { score, warnings: [...warn] };
}

/** 「D.S. al Coda」「Fine」「To Coda」などの文字を、小節の記号にする（当てはまらなければ null） */
export function readFlowWords(words: string): Pick<MeasureAttrs, 'fine' | 'toCoda' | 'jump'> | null {
  const w = words.replace(/\s+/g, ' ').trim();
  if (/^fine\.?$/i.test(w)) return { fine: true };
  if (/^to coda/i.test(w)) return { toCoda: true };
  const m = /^(d\.\s?c\.|d\.\s?s\.|da capo|dal segno)(?:\s+al\s+(fine|coda))?\.?$/i.exec(w);
  if (!m) return null;
  const head = m[1].toLowerCase();
  const base = head.startsWith('d.') ? (head.includes('c') ? 'dc' : 'ds') : head === 'da capo' ? 'dc' : 'ds';
  const tail = m[2]?.toLowerCase();
  return { jump: (tail ? `${base}-${tail}` : base) as JumpKind };
}

/** <time-modification> と <tuplet> から、連符のまとまりを読む */
function readTuplet(c: Element, st: Pick<VoiceState, 'tup'>, ev: TimedEvent) {
  const tm = kid(c, 'time-modification');
  const actual = Math.round(num(tm, 'actual-notes'));
  const normal = Math.round(num(tm, 'normal-notes'));
  const type = TYPES[txt(c, 'type')];
  if (!tm || !type || actual < 1 || normal < 1) { st.tup = null; return; }
  const dots = kids(c, 'dot').length;
  const marks = Array.from(c.getElementsByTagName('tuplet')).map((t) => t.getAttribute('type'));
  if (!st.tup || marks.includes('start') || st.tup.actual !== actual || st.tup.normal !== normal) {
    const nt = TYPES[txt(tm, 'normal-type')];
    const unit = nt ? ticksOf(nt, kids(tm, 'normal-dot').length) : ticksOf(type, dots);
    st.tup = { key: uid(), actual, normal, filled: 0, full: unit * actual };
  }
  ev.tuplet = { key: st.tup.key, actual, normal, duration: type, dots };
  st.tup.filled += ticksOf(type, dots);
  if (marks.includes('stop') || st.tup.filled >= st.tup.full) st.tup = null;
}

function readPitch(el: Element): Pitch {
  const s = txt(el, 'step').toUpperCase() as Step;
  return {
    step: STEPS.includes(s) ? s : 'C',
    alter: Math.max(-2, Math.min(2, Math.round(num(el, 'alter')))),
    octave: Math.round(num(el, 'octave', 4)),
  };
}
