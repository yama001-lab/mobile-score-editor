# 設計メモ

## データの流れ

```
入力（タップ／キーボード／鍵盤／手書き／PDF取り込み）
        │
        ▼
   Editor（src/editor/editor.ts） ── 元に戻す用のスナップショット
        │ 変更通知
        ├──▶ render（VexFlowでSVG描画） ──▶ 画面 / PDF
        └──▶ storage（localStorageに自動保存）
```

楽譜データ（`src/model/score.ts`）は JSON にそのまま書ける形で、`schemaVersion` を持ちます。
形を変えるときは `schemaVersion` を上げ、`src/storage/local.ts` の `migrate()` に変換を足します。

- 長さはティック（4分音符 = 480、MIDIと同じ）
- 音高は `{ step, alter, octave }`。`toMidi()` / `fromMidi()` で MIDI 番号と変換
- 全パートの小節数は常に同じ。小節はいつも音符と休符でちょうど埋まっている

## 画面の配置

- `header.topbar`：アプリ全体の操作（ファイル・再生・元に戻す・設定・書き出し）
- `#stage`：楽譜（`#score-wrap`）と、その上に浮かぶ表示倍率・モードの説明・お知らせ（`toast()`）
- `footer#dock`：道具バー（`.modes` に入力方法、`#palette` に道具のグループ）と入力パネル（`#input-panel`）
- アイコンは `src/ui/icons.ts`。HTML で `data-icon="名前"` を付けると `applyIcons()` が入れる

道具を足すときは `#palette` に `.group` を足すか、既存のグループに `button.tool`（アイコン＋短い名前）を足す。
ポップアップのメニューは `#measure-menu` と同じ形で作れる。

## 今後のステップの差し込み口

### ステップ2：iPad鍵盤入力と再生（実装済み）
- `src/input/keyboard.ts` の `PianoKeyboard` が `#input-panel` に鍵盤を描き、押された MIDI 番号を返す。
  `main.ts` が `editor.inputMidi(midi, chord)` を呼ぶ（他の鍵を押さえたまま押したら chord=true）
- 再生は `src/audio/`。`buildSchedule()` が楽譜を秒単位の音の一覧にし（タイは1音にまとめる）、
  `Player` が少し先までを Web Audio で予約していく。音色はパートの `instrument`（`piano` / `synth`）

### ステップ3：五線への手書き入力
- 描画結果の `MeasureHit`（小節の位置、第1線のY、線の間隔、音部記号）で、ペンの座標を五線上の位置に直せる
  （`diatonicAtY()`）。認識した音符は `editor.setInputDuration()` と `editor.inputDiatonic()` で入れる
- ペンは Pointer Events（`pointerType` が `pen` または `touch`）。安価なスタイラスは `touch` として届くことが多い
- 画面の入口は道具バーの「手書き」（`[data-mode="pen"]`、いまは準備中の案内を出すだけ）。
  `Editor` の `Mode` に `'pen'` を足し、手書きモードの間は `#score` の上に描画用の層を重ねて線を受け取る

### ステップ4：PDF楽譜の取り込み
- OMR（Audiveris など）の出力は MusicXML が一般的なので、`MusicXML → Score` の変換器を `src/import/` に作る
- 同じ変換器で MusicXML の読み書きにも対応できる
- 画面の入口はファイル画面の「PDF・画像の楽譜を取り込む」（`#btn-import-pdf`、いまは準備中の案内だけ）
