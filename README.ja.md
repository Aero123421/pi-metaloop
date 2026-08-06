# pi-metaLoop

[pi](https://github.com/earendil-works/pi) のための適応型監督オーケストレーション — 短いタスクは軽いままで、長いタスクだけ監督付きの分業レイヤーを立ち上げ、認識ズレを早期に止める。

[English README](./README.md)

## 思想

> 普段は普通の pi。長いタスクだけ、静かに監督付き分業を立ち上げ、認識ズレが膨らむ前に止める。

- **非対称起動** — 質問・git 確認・議論・小修正はオーバーヘッドゼロ、追加エージェントなし
- **早期アラインメント監査** — Worker 本格稼働の前に Supervisor が計画を一度監査（コードレビューではなく作業設計のレビュー）
- **権限分離** — ユーザー意図の所有者は常に Primary 一つ。計画の所有者・異常の検出者も分離
- **外付けメタ認知** — 監視と制御はハーネス側で行う。モデルの自己反省には頼らない

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

pi パッケージとして:

```bash
pi install git:github.com/Aero123421/pi-metaloop
# またはローカルパス
pi install /path/to/pi-metaLoop
```

`~/.pi/agent/settings.json` に追加してもよい:

```json
{ "extensions": ["/path/to/pi-metaLoop"] }
```

インストールなしで試す:

```bash
pi -e /path/to/pi-metaLoop/src/index.ts
```

## 設定

`config/meta-loop.json`（デフォルト）。プロジェクト側は `.pi/meta-loop.json` で上書き:

- `enabled` — 全体キルスイッチ
- `roles.<role>.model` — 役別モデル（空 = pi デフォルト継承）
- `roles.<role>.tools` — 役が使えるツール
- `supervisor.auto` — 自動監査フックの有効/無効
- `supervisor.checkIntervalMinutes` — 定期監査間隔（標準 30 分）
- `supervisor.workerStartThreshold` — Worker 起動数がこの値に達したら監査（標準 6）
- `supervisor.maxConsecutiveFailures` — この数の連続失敗で即時監査（標準 2）
- `limits.maxTasks` — チケット上限（標準 8）
- `limits.perTaskOutputCap` — サブプロセスごとの出力上限

## コマンドと UX

- 長期タスクは Primary が自分で `orchestrate` を呼ぶ。使わせたい場合は「長期タスクなので orchestrate で」と明示すればよい
- `/tasks` — タスクボード表示
- `/verdicts` — Supervisor の判定履歴
- supervised 中はフッターに薄いステータス: `supervised executing 3 tasks ●1 ✓2 review:green`

ユーザーに見える会話は一本。内部実況は出さず、計画・認識ズレの修正・本当に必要な判断・完了物だけを表に出す。

## 開発

```bash
npm install
npm run typecheck    # tsc --noEmit (strict)
```

## セキュリティ

この拡張はあなたの権限で `pi` サブプロセスを起動する。エージェントのプロンプトはこのリポジトリ内のもののみを使用する（プロジェクトローカルのエージェント定義は読み込まない）。他の pi パッケージと同様に、インストール前にコードを確認すること。

## ロードマップ

- [x] Phase 1 — orchestrate ツール / 初期監査 / G-Y-R / 作業票 / 役別モデル
- [x] Phase 2 — Supervisor 自動フック / ステップ駆動 Orchestrator / guidance 挿入 / 会話文脈 / 点検基準
- [ ] Phase 2.5 — Worker 並列実行、`tool_call` フックによるスコープ逸脱検知
- [ ] Phase 3 — ハーネス診断（反復障害から rules/skills/prompts の弱点指摘）
- [ ] Phase 4 — 進化ループ（ログとスコアの蓄積、外側 improver）— 研究寄り、任意

## ライセンス

MIT
