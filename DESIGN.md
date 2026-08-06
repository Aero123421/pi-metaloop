# DESIGN — pi-meta-loop (0.2.0-alpha)

## 正体

長期タスク向けの **fail-closed 監督ハーネス（α）**。  
モデルの自己申告だけでなく、ハーネスが evidence（exit / git dirty / scope）を見る。

## 権限（能力境界）

| 役 | デフォルト tools |
|----|------------------|
| Orchestrator | read, ls, find, grep（**bash なし**） |
| Supervisor | read, ls, find, grep（**bash なし**） |
| Worker | read, write, edit, ls, find, grep（**bash なし**） |
| sfh group | access は config で `read` / `write` / `full`（既定 `read`） |

Project config は user/default の能力を**狭めるだけ**（sfhBinary 変更・access 引き上げ・allowlist 拡大は不可）。

## 監査

- Supervisor には **フル ticket JSON**（acceptance / scope / branches / claim / evidence）
- 初回 audit は **fail-closed**（不正 JSON / 非0 exit → 実行しない）
- blocked / out-of-scope は即時 re-audit
- Primary への tool `content` は `buildPrimarySummary`（変更ファイル・tests・未解決を含む）

## 完了判定

WorkerClaim（自己申告）と ExecutionEvidence（exit + git + scope）を分離し、ハーネスが最終 status を決める。

## 設定

`default → repo → user → legacy project → folder project`  
folder が legacy に勝つ。standards は優先度高い層を cap 内で優先保持。

## 既知の限界（α）

- bash を user 設定で Worker に戻すと scope は git evidence 頼みになる
- セッション永続化なし（board はメモリ）
- チケット実行中の壁時計 Supervisor は未実装（チケット境界）
- nesting guard は協調的経路向け
