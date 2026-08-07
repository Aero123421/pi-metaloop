# pi-meta-loop

**Status: 0.2.0-alpha（実験的）。** [pi](https://github.com/earendil-works/pi) 向け適応型監督オーケストレーション。

短いタスクは軽いまま。長いタスクは Orchestrator + Supervisor + Worker/sfh。**初回監査は fail-closed**、完了は **evidence ベース**、権限は **能力境界**（プロンプトだけに頼らない）。

[English README](./README.md)

## 思想

> 普段は普通の pi。長いタスクだけ、静かに監督付き分業を立ち上げ、認識ズレが膨らむ前に止める。

- **非対称起動** — 質問・git 確認・議論・小修正はオーバーヘッドゼロ、追加エージェントなし
- **早期アラインメント監査** — Worker 本格稼働の前に Supervisor が計画を一度監査（コードレビューではなく作業設計のレビュー）
- **権限分離** — ユーザー意図の所有者は常に Primary 一つ。計画の所有者・異常の検出者も分離
- **外付けメタ認知** — 監視と制御はハーネス側で行う。モデルの自己反省には頼らない

## 前提（必須依存）

- [pi](https://github.com/earendil-works/pi)（この拡張の本体）
- **[sfh (SimpleFlowHarness)](https://github.com/Aero123421/SimpleFlowHarness) — 必須依存**。グループチケット（`execution: "sfh"`）の実行に使う

```bash
# Windows PowerShell
irm https://github.com/Aero123421/SimpleFlowHarness/releases/latest/download/sfh-installer.ps1 | iex
# macOS / Linux
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/Aero123421/SimpleFlowHarness/releases/latest/download/sfh-installer.sh | sh
```

sfh 未インストールの場合、グループチケットはインストール手順付きのエラーでブロックされる（通常チケットはそのまま動く）。

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

Supervisor への入力: ユーザー要求の原文、Primary との会話ダイジェスト（議論・合意）、タスクボード、実行統計、注入済み guidance 履歴、点検基準。

## 役割と基準の分離

- `agents/supervisor.md` — **どう見るか**（役割定義・安定層）
- `config/standards.md` — **何を見るか**（デフォルト基準: コード品質・テスト・セキュリティ・スコープ）
- `<プロジェクト>/.pi/meta-loop-standards.md` — プロジェクト個別基準（デフォルトに追加）

Supervisor は基準を判定根拠にする。**基準にない事項は optional_advice に留め、yellow/red の根拠にしない**（過剰介入防止）。Orchestrator にも基準が渡されるため、初期計画からチケットに反映される。

## インストール

```bash
pi install git:github.com/Aero123421/pi-metaloop
pi install /path/to/pi-metaLoop
```

または `~/.pi/agent/settings.json` の `extensions` にパスを追加。

### 初回セットアップ（skill・明示呼び出し）

```text
/skill:meta-loop-setup
```

対話で user/project スコープ、役別モデル、sfh の許可 tool・model/effort/access、standards を決め、`~/.pi/agent/meta-loop/` や `.pi/meta-loop/` に書き出す。

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

### sfh モデル（並列グループのブランチ）

sfh はステップ単位で `model` を取れる。ブランチごとの解決順:

1. チケットの `branches[].model`（Orchestrator が明示）
2. `executor.sfhToolModels[tool]`（tool ごとの既定）
3. `executor.sfhModel`（sfh 全体の既定）
4. `tool: pi` のときだけ `roles.worker.model`

統合ステップは `sfhIntegrateModel` → `sfhModel` → `roles.worker.model`。

```json
{
  "executor": {
    "sfhModel": "",
    "sfhIntegrateModel": "",
    "sfhToolModels": {
      "pi": "provider/model-id",
      "opencode": "",
      "codex": "",
      "claude": ""
    }
  }
}
```

例: `examples/user-meta-loop.config.example.json` / `examples/project-meta-loop.config.example.json`

その他のキー:

- `enabled` — 全体キルスイッチ
- `roles.<role>.tools` — 役が使えるツール
- `supervisor.auto` — 自動監査フックの有効/無効
- `supervisor.checkIntervalMinutes` — 定期監査間隔（標準 30 分）
- `supervisor.workerStartThreshold` — Worker 起動数がこの値に達したら監査（標準 6）
- `supervisor.maxConsecutiveFailures` — この数の連続失敗で即時監査（標準 2）
- `executor.sfhEnabled` — グループチケットを sfh に委譲するか（標準 true）
- `executor.sfhBinary` — sfh バイナリ名/パス（標準 `sfh`）
- `executor.timeoutSec` — グループごとの壁時計上限（標準 1800）
- `executor.maxParallel` — sfh の最大並列数（標準 4）
- `limits.maxTasks` — チケット上限（標準 8）
- `limits.perTaskOutputCap` — サブプロセスごとの出力上限

## グループチケット（並列ブランチ＋統合約）

Orchestrator は、調査・探索・比較のような並列向き作業を複数チケットではなく **1 枚のグループチケット** として切れる:

```json
{
  "id": "research-01",
  "execution": "sfh",
  "goal": "OAuth 対応の調査と既存コード探索",
  "branches": [
    { "id": "web", "tool": "opencode", "prompt": "ライブラリ比較…" },
    { "id": "code", "tool": "pi", "prompt": "既存認証フローの調査…" }
  ],
  "integration": { "acceptance": ["全ブランチ網羅", "矛盾点列挙", "出典明記"] }
}
```

runtime は `flow.yaml` を生成（`.pi/meta-loop/flows/` に保存）し、`PI_META_LOOP_DEPTH=1` を env に持って `sfh run` をフォアグラウンド実行する。統合報告（sfh の stdout）とコスト/経過時間はボードに回収される。実行中のライブ進捗は TUI モニターが表示する。

実装チケットはネイティブ（Worker の pi サブプロセス）のまま。グループは並列化できる調査系作業専用。

## コマンドと UX

- 長期タスクは Primary が自分で `orchestrate` を呼ぶ。使わせたい場合は「長期タスクなので orchestrate で」と明示すればよい
- **TUI では orchestrate はデフォルト background** — 起動直後に tool が return し、メイン会話をブロックしない。完了時に `meta-loop-result` が followUp 注入される
- 同期実行が必要なら `background: false`（print/json モードは自動で同期）
- `/tasks` — ライブ or 直近のタスクボード
- `/verdicts` — Supervisor の判定履歴
- `/ml-stop` — 実行中の supervised run を中断
- `/ml-runs` — ディスク上の run 履歴（`.pi/meta-loop/runs/`）
- `/sfh` — sfh 実行履歴。`/sfh stop` で最新 run 停止
- supervised 中は **色付き統合パネル**（meta-loop + sfh）とフッターで進捗表示
- `/ml-ui` — 詳細度 `compact|normal|full`（`show`/`hide` 可）。ショートカット `ctrl+shift+m`
- 終了 run は約90秒で **自動非表示**（stopped が永遠に残らない）。`/tasks` で再表示
- 役サブプロセスの task は **stdin** 渡し（Windows の ENAMETOOLONG を回避）
- **ソフトな途中昇格**: tool 回数・パス数・write 数、または長い要求文で一度だけ `orchestrate` 検討を nudge（強制しない）
- sfh フロー実行中もフッター + ウィジェット。stuck は必ず通知

内部実況はウィジェット側。チャット本文には計画・必要な判断・完了サマリを出す。

## 開発

```bash
npm install
npm run typecheck    # tsc --noEmit (strict)
```

## セキュリティ

この拡張はあなたの権限で `pi` サブプロセスを起動する。エージェントのプロンプトはこのリポジトリ内のもののみを使用する（プロジェクトローカルのエージェント定義は読み込まない）。他の pi パッケージと同様に、インストール前にコードを確認すること。

**入れ子起動の防止**: サブプロセスには `PI_META_LOOP_DEPTH >= 1` が渡され、この拡張は何も登録しない。worker・各役のサブプロセス・sfh が起動した pi は orchestrate を物理的に持たず、再帰は構造的に不可能。

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
- [ ] Phase 3 — ハーネス診断（反復障害から rules/skills/prompts の弱点指摘）
- [ ] Phase 4 — 進化ループ（ログとスコアの蓄積、外側 improver）— 研究寄り、任意

## ライセンス

MIT
