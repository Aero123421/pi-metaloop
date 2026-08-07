# DESIGN — pi-meta-loop (0.2.6-alpha)

## 正体

長期タスク向けの **fail-closed 監督ハーネス（α）**。  
モデルの自己申告だけでなく、ハーネスが evidence（exit / git dirty / scope）を見る。

## 権限（能力境界）

| 役 | デフォルト tools |
|----|------------------|
| Orchestrator | read, ls, find, grep（**bash なし**） |
| Supervisor | read, ls, find, grep（**bash なし**） |
| Worker | read, write, edit, ls, find, grep, **bash**（project で狭め可） |
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

## UX / 実行モデル（0.2.1–0.2.2）

- **TUI では orchestrate はデフォルト background** — tool は即 return、チャット継続可
- 完了時 `meta-loop-result` を `sendMessage({ followUp, triggerTurn })` で注入
- 停止: `/ml-stop`（AbortController）
- 状態: footer + **widget（belowEditor）** + `/tasks` `/ml-runs`
- board 永続化: `.pi/meta-loop/runs/<runId>/board.json` + `latest.json`
- 役サブプロセスの task は **stdin**（argv に載せない → Windows ENAMETOOLONG 回避）
- **終了セマンティクス（0.2.2）**: `plan_failed` / 全 blocked → `incomplete` or `error`（偽の `done` にしない）
- plan は最大2回・outputCap≥200k、raw を `plan-attempt-*.txt` に保存
- widget の elapsed は `finishedAt` で固定
- **0.2.3 TUI**: meta-loop と sfh を同一 belowEditor パネルに統合（色バッジ・進捗バー・ticket 一覧・スピナー）。`/ml-ui` で detail 切替。終了後 ~90s で auto-hide
- **0.2.4**: scope は **ticket delta のみ**（前チケットの dirty を違反にしない）。sfh パネルは live/直近45s のみ。停止は `/ml-stop`・`runs/<id>/STOP`・`force=true`。integrate access は branch の max に昇格、codex model なら tool=codex
- **0.2.5**: mid-review compact board；verdictHistory 永続化；Orchestrator は短いスライス計画；`/tasks` ドリルダウン；user config で sfh full 天井（project の full が効く）
- **0.2.6**: allowed_scope の globstar (`crates/**/tests/**`) を正しく解釈。末尾ディレクトリ自体と子ファイルを同じ規則で許可し、security test directory の偽 scope violation を防止

## 既知の限界（α）

- Worker 既定に bash があるため、scope は git evidence + allowed_scope ガード頼み（危険コマンドはユーザー責任）
- background 中に Primary が同じ tree を編集すると Worker と衝突しうる（ユーザー判断）
- チケット実行中の壁時計 Supervisor は未実装（チケット境界）
- nesting guard は協調的経路向け
- クラッシュ後の run は session_start で `stopped` に落とす（自動再開なし）
- project config は access/tools を**広げられない**（user 層で ceiling を上げる）
