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

### ステップ3：五線への手書き入力（実装済み）
- `src/handwriting/pen.ts` の `PenLayer`：手書きモード（`Mode` の `'pen'`）の間だけ `#score` の上に canvas を重ね、
  線を集める。書き終えて 650ms 待つか、前の記号から右に離れて書き始めたら `onRecognize` に渡す。
  `pointerType` が `pen` ならいつも書く。`touch` は「指で書く」がオンのときだけ（安価なスタイラスは `touch` で届く）。
  2本指は書きかけを捨てて手動でスクロール、接触面の大きいもの（手のひら）は無視
- `src/handwriting/recognize.ts`：機械学習なしの図形判定。長さは五線の間隔を単位に比べる。
  `clusterStrokes()` で横に離れた線を別の記号に分け、`recognizeCluster()` が
  符幹（長い縦の線分）→ 頭（塗りつぶしか輪か）→ 旗・付点・臨時記号、の順に調べる。
  符幹がなければ全音符・黒丸・休符・臨時記号・点・消しゴムを調べる
- `src/handwriting/apply.ts`：読み取り結果を `Editor` の操作に変える（入力位置より右なら続けて入れる、
  既存の音符の真上・真下なら和音、点・臨時記号は近くの音符へ、消しゴムは `editor.eraseEvents()`）
- 精度を上げるときは `tests/handwriting.test.ts` に形を足してから `recognize.ts` のしきい値を変える。
  手ぶれ（乱数のずれ）を入れた試験もある

### ステップ4：PDF楽譜の取り込み
- OMR（Audiveris など）の出力は MusicXML が一般的なので、`MusicXML → Score` の変換器を `src/import/` に作る
- 同じ変換器で MusicXML の読み書きにも対応できる
- 画面の入口はファイル画面の「PDF・画像の楽譜を取り込む」（`#btn-import-pdf`、いまは準備中の案内だけ）
