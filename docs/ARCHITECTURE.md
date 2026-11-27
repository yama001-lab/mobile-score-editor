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

### ステップ4：PDF楽譜の取り込み（実装済み）
- 入口は `src/import/index.ts` の `importFile()`。中身を見て種類を判断する
  - MusicXML（.musicxml / .xml）→ `src/import/musicxml.ts` の `parseMusicXml()`。.mxl（zip）は `mxl.ts` で展開（fflate）
  - このアプリの PDF → 書き出し時に文書情報（Keywords）へ `MSE-SCORE1:` + base64 の楽譜JSONを入れてある（`embed.ts`）。それを取り出すだけ
  - ほかの PDF・写真 → `needs-omr` を返し、画面（`#dlg-import-help`）で Audiveris（パソコンの無料OMR）→ .mxl → 取り込み の手順を案内
- MusicXML → Score は「曲頭からのティック付きの音の並び」（`timeline.ts`）を作ってから小節に詰め直す。
  1段1声部、2段のパートは段ごとに別パート、拍子は最初のものだけ、連符は32分音符の格子に丸める。弱起は1小節目の後ろに寄せる
- 逆向き（Score → MusicXML）は `src/export/musicxml.ts`。MuseScore などへ持っていける
- ブラウザ内だけでの OMR（画像から直接読む）は未実装。やるなら `importBytes()` の `needs-omr` の所に差し込む

### 歌詞・コードネーム・文字・練習番号
- データ：音符・休符の `EventTexts`（`lyrics`（番ごと、末尾 `-` で次の音節とハイフン）・`chord`・`text`）と、
  いちばん上のパートの小節の `rehearsal`。どれも省略できるので `schemaVersion` は変えていない
- 共通処理は `src/model/texts.ts`（次の音符の探し方、コードネームの読み取りと ♯♭ 表示、練習番号の続き）
- 入力は `src/ui/text-entry.ts`。パレットに「歌詞・コード・文字・練習番号」を足し、楽譜の上端に入力欄を出す。
  歌詞はスペース／Enter で次の音符（休符とタイの続きはとばす）、`-` でハイフン。日本語の変換中のスペース・Enter は変換に使う。
  楽譜の文字をタップすると直せる（`main.ts` の pointerdown／up から `texts.pointerDown/Up` を呼ぶ）
- 描画は `src/render/texts.ts`。文字の幅のぶん見えない Annotation を音符に付けて間隔を空け、段ごとに高さをそろえて描く。
  歌詞・文字のあるパートは譜表の間を広げる（`partOffsets()`）
- PDF は日本語の標準フォントがないため、`renderPage()` の `textSink` で文字を集めて、1つずつ画像にして載せる
- MusicXML は `<lyric>`・`<harmony>`・`<words>`・`<rehearsal>` で読み書きする
