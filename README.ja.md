# pi-meta-loop

**Status: リリース済み。正確な版は `package.json` を参照。** [pi](https://github.com/earendil-works/pi) 向け適応型監督オーケストレーション。

短いタスクは軽いまま。長いタスクは Orchestrator + Supervisor + Worker。**初回監査は fail-closed**、完了は **evidence ベース**、権限は **能力境界**（プロンプトだけに頼らない）。

[English README](./README.md)

## 思想

> 普段は普通の pi。長いタスクだけ、静かに監督付き分業を立ち上げ、認識ズレが膨らむ前に止める。

- **非対称起動** — 質問・git 確認・議論・小修正はオーバーヘッドゼロ、追加エージェントなし
- **早期アラインメント監査** — Worker 本格稼働の前に Supervisor が計画を一度監査（コードレビューではなく作業設計のレビュー）
- **権限分離** — ユーザー意図の所有者は常に Primary 一つ。計画の所有者・異常の検出者も分離
- **外付けメタ認知** — 判定は別モデルが行い、拘束（トリガ・evidence・verify・fail-closed パース）はハーネス側の決定論的な処理が担う

## 前提（必須依存）

- [pi](https://github.com/earendil-works/pi)（この拡張の本体）
| 依存 | 対応範囲 |
|---|---|
| Node.js | `>=22.19.0` |
| pi / pi-ai | `^0.83.0` |

## 動作

```text
User
  │
  ▼
Primary（普段どおりの会話）
  │
  └─ 長期タスクのみ orchestrate ツールを呼ぶ
     （直前までの会話文脈も一緒に渡す）
        ▼
   Orchestrator（実行計画の所有者・ステップ駆動）
   要求 → 作業票（チケット）に分解。スコープは増やさない。
        │
        ├─ 初期監査: Supervisor（green / yellow / red）
        │     red    → 停止して Primary に返す
        │     yellow → guidance を Orchestrator に挿入し計画修正
        │     green  → 実行へ
        │
        ├─ Worker x N（1 チケット = 1 成果物 + 1 検証方法 + 限定スコープ）
        │
        └─ Supervisor は自動で再監査（hook 的）
              ・30分経過（checkIntervalMinutes）
              ・Worker 6 起動（workerStartThreshold）
              ・連続失敗 / blocked
              → 介入は Orchestrator へのプロンプト挿入のみ
```

各役は隔離された `pi` サブプロセス（`--mode json -p --no-session`）で実行。
**役ごとにモデルを分けられる**（config の `roles.*.model`）。

## 役割と権限

| 役 | 責務 | やってはいけないこと |
|---|---|---|
| Primary | ユーザー意図の所有・最終回答 | — |
| Orchestrator | 計画・分解・割当 | スコープ追加・要求の再解釈 |
| Supervisor | 全体監督・メタ認知（外付け）・G/Y/R 判定・自動 hook | 実装・新機能追加・再解釈・Worker 直接介入 |
| Worker | 担当成果物 | スコープ外の変更・方針変更 |

Supervisor の介入は **常に Orchestrator 経由**（プロンプト挿入）。Worker への直接指示はしない。red 時の停止は介入ではなく runtime 制御。

## 自動監査フック（config 駆動）

| トリガー | デフォルト |
|---|---|
| 前回監査からの経過時間 | 30 分 |
| 前回監査からの Worker 起動数 | 6 |
| 連続失敗 | 2 で即時 |
| Worker が blocked（前提不足） | 即時 |

初回監査と最終監査での Supervisor への入力: ユーザー要求の原文、Primary との会話ダイジェスト（議論・合意）、フルのタスクボード、実行統計、注入済み guidance 履歴、点検基準。実行中の監査は意図的に軽く、goal と constraints・compact ボード・統計のみを送る。

## 役割と基準の分離

- `agents/supervisor.md` — **どう見るか**（役割定義・安定層）
- `config/standards.md` — **何を見るか**（デフォルト基準: コード品質・テスト・セキュリティ・スコープ）
- `<プロジェクト>/.pi/meta-loop-standards.md` — プロジェクト個別基準（デフォルトに追加）

Supervisor は基準を判定根拠にする。**基準にない事項は optional_advice に留め、yellow/red の根拠にしない**（過剰介入防止）。Orchestrator にも基準が渡されるため、初期計画からチケットに反映される。

## インストール

```bash
pi install git:github.com/Aero123421/pi-metaloop
pi install /path/to/pi-meta-loop
```

または `~/.pi/agent/settings.json` の `extensions` にパスを追加。

### 最初にやること

初期状態では **trusted verify が未設定**。作業自体は完了するが、どの run も `verified` とは名乗れず、結果は `completed · unverified` として報告される（要約にもそう書かれる）。最初の実運用の前に verify profile を設定すること:

```text
/skill:meta-loop-setup     # 対話で config を書き出す
/ml-doctor                 # 実効ゲート・argv・許可元を表示
```

`orchestrate` は起動時にゲート未設定を警告するので、1 run 使い切る前に気づける。

### 初回セットアップ（skill・明示呼び出し）

```text
/skill:meta-loop-setup
```

対話でuser/projectスコープ、役別モデル、承認済みverify profile、standardsを決め、`~/.pi/agent/meta-loop/`や`.pi/meta-loop/`に書き出す。

## 設定

読み込み順（後ろが優先）:

```text
1. 拡張リポジトリ config/meta-loop.json          （出荷デフォルト）
2. ~/.pi/agent/meta-loop/config.json             （ユーザー全体 — 役別モデルはここに）
3. <プロジェクト>/.pi/meta-loop/config.json       （プロジェクト上書き）
```

基準ファイルも同じフォルダ:

```text
~/.pi/agent/meta-loop/standards.md
<プロジェクト>/.pi/meta-loop/standards.md
```

### 役別モデル（pi サブプロセス）

```json
{
  "roles": {
    "orchestrator": { "model": "provider/model-id" },
    "supervisor":   { "model": "provider/model-id" },
    "worker":       { "model": "provider/model-id" }
  }
}
```

空文字 = pi のデフォルト継承。形式は pi の `--model` と同じ。

### trusted verify profile

run が `verified` を名乗れるのは、controller 自身の verify が実際に走って通ったときだけ。user config で承認済み argv を定義し、project config は profile 名だけを選ぶ。

**2 つの問いには 2 つの答え。** チケットが仕事をしたかと、それを誰かが検査したかは別の事実なので、別々に報告する。実際に走った verify がそのチケットに帰属する regression を見つけたときだけ、そのチケットが `failed` になる。未設定・中断・実行前から失敗していた verify はチケットに触れず、**run** を `unverified` にして理由を残す。検査されていないものが verified として報告されることはない。

```jsonc
// user: ~/.pi/agent/meta-loop/config.json
{ "executor": { "verifyProfiles": { "node": [["npm", "test"], ["npm", "run", "typecheck"]] } } }

// project: .pi/meta-loop/config.json
{ "executor": { "verifyProfile": "node", "verifyTimeoutSec": 600 } }
```

Projectから新しいprofileやargvは追加できない。未設定・abort 時は `partial`、実際に走って回帰を報告した失敗・timeout は `failed` になる。いずれの場合も `done` は拒否される。`/ml-doctor`で実効profile、argv、timeout、許可元を確認できる。

その他のキー:

- `enabled` — 全体キルスイッチ
- `roles.<role>.tools` — 役が使えるツール
- `supervisor.auto` — 自動監査フックの有効/無効
- `supervisor.checkIntervalMinutes` — 定期監査間隔（標準 30 分）
- `supervisor.workerStartThreshold` — Worker 起動数がこの値に達したら監査（標準 6）
- `supervisor.maxConsecutiveFailures` — この数の連続失敗で即時監査（標準 2）
- `executor.timeoutSec` — グループごとの壁時計上限（標準 1800）
- `executor.verifyProfiles` / `verifyProfile` — user承認済みargvとproject選択
- `executor.verifyMode` — `per-ticket`（標準）/ `final`。`final` は実行ループ後に 1 回だけ verify し、その結果が run の verification になる（1 つのゲートではどのチケットが壊したか言えないので、個別チケットには帰属させない）
- `evidence.ignoreDirNames` / `parentMaxDepth` / `maxEntries` / `timeoutMs` — evidence スイープの範囲（user/base 層のみ。project 層は変更できない）
- `limits.maxTasks` — チケット上限（標準 8）
- `limits.perTaskOutputCap` — サブプロセスごとの出力上限
- `limits.maxSupervisions` — 実行中の Supervisor 監査の予算（標準 12。初期/最終監査は常に実行）
- `limits.scopeCeiling` — チケットの `allowed_scope` に対するハーネス側の天井
- `allowProjectModelOverride` — project config に役割モデルの選択を許可する（標準 false）

## コマンドと UX

- 長期タスクは Primary が自分で `orchestrate` を呼ぶ。使わせたい場合は「長期タスクなので orchestrate で」と明示すればよい
- **TUI では orchestrate はデフォルト background** — 起動直後に tool が return し、メイン会話をブロックしない。完了時に `meta-loop-result` が followUp 注入される
- 同期実行が必要なら `background: false`（print/json モードは自動で同期）
- `/tasks` — ライブ or 直近のタスクボード
- `/verdicts` — Supervisor の判定履歴
- `/ml-stop` — 実行中の supervised run を中断
- `/ml-runs` — ディスク上の run 履歴（`.pi/meta-loop/runs/`）
- `/ml-approve` — 承認待ちの計画をレビュー（承認 / 再計画 / 却下）
- `/ml-resume [runId]` — 前回の run の失敗・未完了チケットだけを再実行（完了済みには触らない）
- `/ml-doctor` — native done 条件と、実効的な能力境界
- supervised 中は **フラットな色付きパネル**とフッターで進捗表示
- `/ml-ui` — 詳細度 `compact|normal|full`（`show`/`hide` 可）。ショートカット `ctrl+shift+m`
- 終了 run は約90秒で **自動非表示**（stopped が永遠に残らない）。`/tasks` で再表示
- 役サブプロセスの task は **stdin** 渡し（Windows の ENAMETOOLONG を回避）
- **ソフトな途中昇格**: tool 回数・パス数・write 数、または長い要求文で一度だけ `orchestrate` 検討を nudge（強制しない）

内部実況はウィジェット側。チャット本文には計画・必要な判断・完了サマリを出す。

## 開発

```bash
npm ci
npm run typecheck    # tsc --noEmit (strict)
npm test
```

## セキュリティ

- Orchestrator / Supervisor / Worker のデフォルト tools に **bash は含まれない**。
- Worker の tools は **built-in の厳密 allowlist**（`read`/`write`/`edit`/`ls`/`find`/`grep`）。native worker は `--no-extensions -e scope-guard` で起動するため、project/user の拡張が tools を上書きできない。`allowed_scope` は write/edit で強制され、実行後に git + filesystem evidence でも検査される。alias/args/config 由来の bash・独自 tool は除去され、bash は tool_call ゲートでも拒否される。
- ビルド/テストは **controller 側の決定論的 verify**（`verifyProfiles` の argv 配列、shell なし）。実際に走って regression を見つけた verify だけがチケットを `failed` にし、それ以外は run を `unverified` にする（`evidence.verify` と `board.verification` に記録）。
- **verify profile の承認は、対象リポジトリ自身のコードを実行する許可を意味する。** `["npm","test"]` はそのリポジトリの `package.json` とテストコードが定義したものを実行する。profile が固定するのは*コマンド*であって、その先の中身ではない。手動でテストを走らせてよいと思えるリポジトリに限り、グローバルな `verifyCommands` よりプロジェクトごとの `executor.verifyProfile` 選択を優先すること。
- `approval.initialPlan` は、書き込みが始まる前に人間が計画を見る条件を決める: `findings`（既定）は監査が clean でないとき、`always` は毎回、`off` は聞かない。project 層は引き上げのみ可能で、`red` 監査はゲートに到達せず run を止める。
- `limits.scopeCeiling` は各チケットの `allowed_scope` の天井になる。未設定の場合、書き込み範囲は Orchestrator の計画が完全に決める。
- ハーネスが介入できない executor の worker は拒否される。scope の執行はツールコール時に行われるので、介入できない executor は事後 evidence でしか確認できず、それは検出のバックストップであって執行機構ではない。
- project config は user/default に対して能力を**狭めることしかできない**: tool allowlist の拡大、verify argv の追加、そして**役割モデルの選択**はできない（`allowProjectModelOverride` で明示的に許可した場合を除く）。
- project の `standards.md` はプロンプト内で **untrusted な判定基準データ**として扱う。
- `.pi/meta-loop/flows/` の生成物にはユーザーのテキストが含まれうる。gitignore し、シークレットをコミットしないこと。
- run ディレクトリはプロンプトとモデル出力を保持する。新しい 20 件まで自動削除される。

**入れ子起動の防止**: 子プロセスには `PI_META_LOOP_DEPTH >= 1` が渡されるため、この拡張は通常経路で何も登録しない。これは事故による再オーケストレーションを防ぐためのものであり、env を消して任意のバイナリを起動できるプロセスに対する**敵対的なセキュリティ境界ではない**（Worker はデフォルトで bash を持たない）。

## ロードマップ

- [x] Phase 1 — orchestrate ツール / 初期監査 / G-Y-R / 作業票 / 役別モデル
- [x] Phase 2 — Supervisor 自動フック / ステップ駆動 Orchestrator / guidance 挿入 / 会話文脈 / 点検基準
- [x] sfh TUI モニター — status.json ポーリング / フッター・ウィジェット / `/sfh` / 入れ子ガード
- [x] Phase 2.5 — sfh 実行バックエンド：グループチケット・統合約・flow.yaml 生成・結果回収
- [x] 硬化 — ドキュメント掃除、sfh チケット検証、allowed_scope ガード、ソフト長期エスカレーション
- [x] 0.2.1 — background orchestrate / TUI widget / board 永続化 / stdin task（ENAMETOOLONG 修正）
- [x] 0.2.2 — Worker 既定 bash、plan_failed/incomplete、plan リトライ+raw 保存、elapsed 固定
- [x] 0.2.3 — ML+sfh 統合カラー TUI、詳細度切替、終了 auto-hide、スピナーフッター
- [x] 0.2.4 — scope delta のみ、STOP ファイル解除、force orchestrate、sfh ゴースト除去、integrate access/tool 修正
- [x] 0.2.5 — mid-review compact、verdictHistory、短い計画、/tasks ドリルダウン、user sfh full 天井
- [x] 0.2.6 — globstar scope 判定（`**/tests/**` のディレクトリ自体も許可）
- [x] 0.2.6 — Worker bash 廃止（built-in のみ）/ sfh write/full は OS sandbox なしで拒否
- [x] 0.3.0-rc.1 — verify profiles / `/ml-doctor` / SFH machine envelope / 配布契約
- [x] 0.3.0-rc.2 — evidence の帰責、verify baseline と `verifyMode`、`limits.scopeCeiling`、
      監査予算、役割プロンプトの英語化
- [x] 0.4.0 — sfh executor を撤去し拡張単体で動作。マルチ CLI worker
      （pi / codex / claude / cursor / grok / agy / opencode）は issue #4 で追跡
- [ ] Phase 3 — ハーネス診断（反復障害から rules/skills/prompts の弱点指摘）
- [ ] Phase 4 — 進化ループ（ログとスコアの蓄積、外側 improver）— 研究寄り、任意

## ライセンス

MIT
