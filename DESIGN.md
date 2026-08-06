# DESIGN — pi-metaLoop

この文書は実装よりも先に固めた設計判断の記録。迷ったらここに戻る。

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
Supervisor      = 異常の検出者・メタ認知役（実装禁止・再解釈禁止・Worker 直接介入禁止）
Worker        = 担当成果物の所有者（スコープ外変更禁止）
```

危険なのは「誰がユーザーの意図を最終決定するか」が曖昧になること。
決定権は常に Primary 一つ。

## 非対称起動

- 短タスク（git 確認・議論・小修正）: 追加階層ゼロ
- 長タスク: のみ監督レイヤー
- 迷ったら short で始めて、膨らんだら途中昇格（誤爆より安全）

## 作業票は時間でなく完了条件で切る

「AI が 30 分」は内部目安。外側の契約は:

```yaml
task_id / goal / deliverables / acceptance / allowed_scope / forbidden / dependencies / report
```

1 チケット = 1 つの明確な成果物 + 1 つの検証方法 + 限定された変更範囲。

## 役割と基準の分離

- `agents/supervisor.md` = **どう見るか**（役割・判定方法・出力形式）。普遍。
- `config/standards.md` + `<プロジェクト>/.pi/meta-loop-standards.md` = **何を見るか**（実装基準・チェック項目）。プロジェクトごとに変わる。
- runtime が基準を読み込み、Supervisor には「点検基準（判定根拠）」、Orchestrator には「実装基準（チケットに反映）」として注入する
- Worker には基準を直接渡さない。Orchestrator がチケットに落とし込んだ分だけ受け取る
- 基準にない事項で Supervisor が yellow/red を出さない規律をプロンプトで固定（過剰介入防止）

## 入れ子起動の防止（決定的）

- `PI_META_LOOP_DEPTH` 環境変数で階層を追跡する
- depth 0 = Primary の pi（orchestrate 登録・sfh 委譲可）
- depth ≥ 1 = 拡張は何も登録しない（worker / orchestrator / supervisor のサブプロセス、および sfh が起動した pi）
- プロンプトのお願いではなく、ツールが物理的に存在しない状態を作る
- sfh 委譲時も同変数を渡す（sfh は env を継承。生成する flow.yaml の `env:` にも明記する）

## sfh 統合（実行エンジンと監視）

- Worker は sfh を使わない。単一チケットは pi が直接実行
- 並列・異種ツールの分岐群は runtime が sfh に直接委譲する（Phase 2.5）
- sfh を起動できるのは depth 0 の orchestrate runtime のみ
- 監視（実装済み）: `.sfh/runs/<run>/status.json` を 2 秒ポーリングで読み、フッター・ウィジェット・`/sfh` に表示。手動実行した sfh も見える
- stuck（人間介入待ち）は必ず通知

## Supervision（自動 hook 駆動）

- **初回監査は必須・早期に**（Worker 本格稼働の前）。作業設計のレビューであり、コードレビューではない
- 2 回目以降は **Supervisor が自動で動く**（config 駆動）:
  - 定期: `checkIntervalMinutes`（標準 30 分）
  - 負荷: `workerStartThreshold`（標準 6 起動）
  - 異常: 連続失敗・blocked は即時
- 判定は Green / Yellow / Red
  - Green: 黙る（ノイズを出さない）
  - Yellow: **Orchestrator にプロンプト挿入**（orchestrator_guidance）。進行は止めない
  - Red: 停止して Primary に返す
- **介入経路は常に Supervisor → Orchestrator のみ**。Worker への直接介入は禁止。誰に何を伝えるかは Orchestrator が決める
- 停止（red）は介入ではなく制御なので runtime が直接行ってよい

## Supervisor の入力（Primary の会話文脈）

- orchestrate 起動時、それまでの Primary との会話（議論・合意・制約）をダイジェスト化して Supervisor と Orchestrator に渡す
- これは「Primary を監視する」ためではなく、**動作のズレを判定する材料**として必要
- 「普段の Primary を常時監視するモード」は作らない（過剰設計のため採用しない）
- Worker は軽量なまま（goal + チケットのみ、会話は渡さない）

## モデル分離

役ごとにモデルを分けられること（roles.*.model）。
監視役と作業役が同じ癖を共有するとズレを増幅するため、分離が実力を出す鍵。

## UX

- ユーザーに見える窓口は Primary 一つ
- 内部実況（「Worker B がコンテキストを取得しました」等）は出さない
- 表に出すのは: 分割した事実、計画の要点、認識ズレの修正、本当に必要な判断、完了物と検証結果

## やらないこと

1. 常時マルチエージェント化
2. Supervisor 自身による実装
3. 生ログ全部を毎回 Supervisor に渡すこと
4. 最初からハーネスの自動書き換え（Meta-Harness 的進化は Phase 4 の任意枠）
5. 「Meta」命名の乱用

## 層の整理（メタ認知 / メタハーネス議論との対応）

```text
L0 モデル内部のメタ認知        → 期待しない
L1 実行時メタ認知ハーネス      → ★本拡張の本体
L2 ハーネス診断 (Better 的)    → Phase 3
L3 ハーネス進化 (Meta 的)      → Phase 4（任意・研究寄り）
```
