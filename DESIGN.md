# DESIGN — pi-metaLoop

この文書は設計判断の記録。迷ったらここに戻る。

## 正体

**長期タスクにだけ起動する、早期アラインメント監査付きのエージェント実行管理システム。**

- 「Meta Subagent」という曖昧な括りは使わない
- PM役（Orchestrator）と監査役（Supervisor）は分離
- メタ認知はモデル内部に期待せず、**外付けハーネスとして実装**する
  （Monitoring = Supervisor、Control = Orchestrator/Primary）

## 権限分離（最優先）

```text
Primary       = 意図の所有者（ユーザー窓口は常に Primary）
Orchestrator  = 実行計画の所有者（スコープ変更禁止）
Supervisor    = 異常の検出者・メタ認知役（実装禁止・再解釈禁止・Worker 直接介入禁止）
Worker        = 担当成果物の所有者（スコープ外変更禁止）
sfh           = 並列実行の配管（判断はしない）
```

決定権は常に Primary 一つ。

## 非対称起動

- 短タスク（git 確認・議論・小修正）: 追加階層ゼロ
- 長タスク: Primary が `orchestrate` を呼ぶのが正式入口
- **ソフトな途中昇格**（強制しない）:
  - Primary セッションの tool 回数・触ったパス数・write 数、または長い要求文を検知
  - セッションあたり一度だけ notify + コンテキスト注入で `orchestrate` を検討させる
  - 閾値は `escalation.*`（config）

## 作業票は時間でなく完了条件で切る

```yaml
task_id / goal / deliverables / acceptance / allowed_scope / forbidden / dependencies / report
# グループ時:
execution: sfh
branches: [{ id, tool, model?, prompt }]
integration: { acceptance: [...] }   # 必須
```

1 チケット = 1 つの明確な成果物 + 1 つの検証方法 + 限定された変更範囲。

## 役割と基準の分離

- `agents/supervisor.md` = **どう見るか**（役割・判定方法・出力形式）
- `config/standards.md` + `~/.pi/agent/meta-loop/standards.md` + `.pi/meta-loop/standards.md` = **何を見るか**
- Supervisor / Orchestrator に注入。Worker にはチケット経由のみ
- 基準にない事項で yellow/red にしない

## 設定の置き場所（3層）

```text
1. 拡張リポジトリ/config/meta-loop.json
2. ~/.pi/agent/meta-loop/config.json     ← 役別・sfh モデルの本命
3. <cwd>/.pi/meta-loop/config.json       ← プロジェクト固有
```

レガシーの `.pi/meta-loop.json` / `.pi/meta-loop-standards.md` も読む。

## モデル割り当て（2系統）

1. **roles.\*.model** — Orchestrator / Supervisor / Worker の pi サブプロセス
2. **executor.sfh\*** — sfh ステップ
   - ブランチ: `branches[].model` > `sfhToolModels[tool]` > `sfhModel` > (pi なら worker.model)
   - 統合: `sfhIntegrateModel` > `sfhModel` > worker.model

監視役と作業役でモデルを分けるのが設計上の意図。

## 入れ子起動の防止（決定的）

- `PI_META_LOOP_DEPTH` で階層追跡
- depth ≥ 1 では拡張は何も登録しない
- sfh flow の `env.PI_META_LOOP_DEPTH=1` も明記

## sfh 統合

- **必須依存**（グループチケット実行用）。native のみなら sfh なしでも orchestrate は動く
- Worker は sfh を使わない。グループは runtime が直接委譲
- 統合約: `integration.acceptance` 必須
- flow は `.pi/meta-loop/flows/` に保存
- TUI: status.json ポーリング、`/sfh`、stuck 通知

## グループチケット検証

- `execution: "sfh"` は `branches` 非空かつ `integration.acceptance` 必須
- 満たさない場合は **blocked**（native にサイレントフォールバックしない）

## allowed_scope の強制

- Worker に `scope-guard.ts` を `-e` で積む（allowed_scope または forbidden があるとき）
- write/edit が scope 外なら tool_call で **block**
- allowed が空なら正の制限なし（forbidden のみ）

## Supervision（自動 hook）

- 初回監査は必須・早期
- 再監査: 30分 / Worker 6 起動 / 連続失敗 2 / blocked
- Green: 黙る / Yellow: Orchestrator に guidance / Red: 停止
- 介入経路は Supervisor → Orchestrator のみ

## Supervisor の入力

- ユーザー要求 + Primary 議論ダイジェスト + ボード + 統計 + 基準
- 「Primary 常時監視モード」は作らない
- Worker に議論全文は渡さない

## UX

- 窓口は Primary 一つ
- フッター: `verdict:green|yellow|red`
- 内部実況は出さない

## やらないこと

1. 常時マルチエージェント化
2. Supervisor 自身による実装
3. 生ログ全部を毎回 Supervisor に渡すこと
4. 最初からハーネスの自動書き換え
5. 「Meta」命名の乱用
6. 長期判定での強制 orchestrate（提案のみ）

## 層の整理

```text
L0 モデル内部のメタ認知        → 期待しない
L1 実行時メタ認知ハーネス      → ★本拡張の本体
L2 ハーネス診断 (Better 的)    → Phase 3
L3 ハーネス進化 (Meta 的)      → Phase 4（任意）
```
