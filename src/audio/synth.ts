/**
 * Web Audio API だけで作る簡単な音源。音源ファイルは使わない（軽さ優先）。
 * - piano: 三角波＋倍音のサイン波を、だんだん暗く・小さくする（減衰する音）
 * - synth: のこぎり波2本を少しずらして重ね、ローパスフィルターを通す（伸びる電子音）
 * iPadのSafariは、画面に触れた操作の中で AudioContext を作り直す／再開する必要がある（unlock()）。
 */
import { Instrument } from '../model/score';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

type AudioContextCtor = typeof AudioContext;

export function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(comp).connect(ctx.destination);
  return ctx;
}

/** 画面に触れたときに呼ぶ。iPadで音が出るようにする。 */
export function unlock() {
  const c = audioContext();
  if (!c) return;
  if (c.state !== 'running') void c.resume();
  // iOSの古い版向け：無音を一度鳴らすと以降の音が出る
  const b = c.createBuffer(1, 1, 22050);
  const s = c.createBufferSource();
  s.buffer = b;
  s.connect(c.destination);
  s.start(0);
}

let a4 = 440;
/** チューニング（A4の周波数 Hz）を変える */
export function setTuning(hz: number) {
  a4 = Math.min(480, Math.max(400, hz || 440));
}
const freqOf = (midi: number) => a4 * Math.pow(2, (midi - 69) / 12);

export interface Voice {
  /** 音を止める（離鍵）。when は AudioContext の時刻、省略で今すぐ */
  stop(when?: number): void;
}

/**
 * 1音を鳴らし始める。start は AudioContext の時刻。
 * duration を渡すとその長さで自動的に止める。
 */
export function playNote(instrument: Instrument, midi: number, start?: number, duration?: number, velocity = 0.8): Voice | null {
  const c = audioContext();
  if (!c || !master) return null;
  const t = Math.max(start ?? c.currentTime, c.currentTime);
  const f = freqOf(midi);
  const out = c.createGain();
  out.connect(master);
  const oscs: OscillatorNode[] = [];
  let release = 0.12;

  if (instrument === 'synth') {
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 2;
    filter.frequency.setValueAtTime(Math.min(f * 6, 9000), t);
    filter.frequency.exponentialRampToValueAtTime(Math.min(f * 3, 6000), t + 0.3);
    filter.connect(out);
    for (const detune of [-7, 7]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = detune;
      o.connect(filter);
      oscs.push(o);
    }
    const peak = 0.13 * velocity;
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(peak, t + 0.015);
    out.gain.linearRampToValueAtTime(peak * 0.7, t + 0.2);
    release = 0.1;
  } else {
    // ピアノ風：高い音ほど早く減衰する
    const decay = Math.max(0.6, 3.2 - (midi - 48) * 0.04);
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(f * 10, 12000), t);
    filter.frequency.exponentialRampToValueAtTime(Math.min(f * 2.5, 8000), t + decay * 0.6);
    filter.connect(out);
    const parts: [OscillatorType, number, number][] = [
      ['triangle', 1, 0.9],
      ['sine', 2, 0.35],
      ['sine', 3, 0.12],
    ];
    for (const [type, mul, gain] of parts) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = f * mul;
      if (mul > 1) o.detune.value = 3;
      const g = c.createGain();
      g.gain.value = gain;
      o.connect(g).connect(filter);
      oscs.push(o);
    }
    const peak = 0.32 * velocity * (midi > 84 ? 0.7 : 1);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(peak, t + 0.004);
    out.gain.exponentialRampToValueAtTime(peak * 0.35, t + 0.25);
    out.gain.exponentialRampToValueAtTime(0.0008, t + decay);
    release = 0.18;
  }

  for (const o of oscs) o.start(t);
  let stopped = false;
  const stop = (when?: number) => {
    if (stopped) return;
    stopped = true;
    const at = Math.max(when ?? c.currentTime, t + 0.01);
    out.gain.cancelScheduledValues(at);
    // 現在値から滑らかに消す（プツッという音を防ぐ）
    out.gain.setTargetAtTime(0, at, release / 4);
    for (const o of oscs) safeStop(o, at + release * 2);
    setTimeout(() => out.disconnect(), Math.max(0, (at - c.currentTime + release * 2) * 1000) + 100);
  };
  if (duration !== undefined) stop(t + duration);
  else if (instrument === 'piano') {
    // 押しっぱなしでも、減衰しきったら止める
    for (const o of oscs) safeStop(o, t + 5);
  }
  return { stop };
}

function safeStop(o: OscillatorNode, when: number) {
  try { o.stop(when); } catch { /* 古いSafariは stop() を2回呼ぶと例外になる */ }
}
