# DESIGN — pi-meta-loop

## 正体

長期タスク向けの **fail-closed 監督ハーネス**。
モデルの自己申告だけでなく、ハーネスが evidence（exit / git / filesystem / controller verify）を見る。

判定そのものは Supervisor というモデル呼び出しで行う。決定論的なのは、トリガ条件・JSON パースの
fail-closed・evidence・verify・capability 境界の側である。

## 権限（能力境界）

| 役 | デフォルト tools |
|----|------------------|
| Orchestrator | read, ls, find, grep（**bash なし**） |
| Supervisor | read, ls, find, grep（**bash なし**） |
| Worker | read, write, edit, ls, find, grep（**bash なし**・intercept 可能な built-in のみ） |
| sfh group | **read-only review**（OS sandbox なしでは write/full を実行・done にしない） |

- Project config は user/default の能力を**狭めるだけ**。sfhBinary 変更・access 引き上げ・allowlist
  拡大・verify argv 追加・**役割モデルの選択**は不可（`allowProjectModelOverride` で明示許可した場合を除く）。
- Native Worker の effective tools は `WORKER_TOOLS` 厳密 allowlist 交差。`--no-extensions` + scope-guard
  のみロード。tool_call guard も bash を無条件拒否。
- `limits.scopeCeiling` が設定されていれば、チケットの `allowed_scope` はその内側に収まることを
  **証明できる**必要がある（`**` や無修飾の `*.ts` は拒否）。未設定なら書き込み範囲は計画（モデル出力）が決める。

## 完了判定

WorkerClaim（自己申告）と ExecutionEvidence（exit + git + filesystem + controller verify）を分離し、
ハーネスが最終 status を決める。native `done` は `verify.status === "passed"` 必須。

### 帰責（attribution）

`failed` は**そのチケットの実行自体に原因があるとき**だけ。以下は `partial`（= 不確定。`done` には
決してならないが、チケットの失敗としては数えない）:

- 実行前後の snapshot が完了できなかった（coverage / timeout）
- shell を持たない native Worker の実行中に HEAD/index が動いた（＝外部プロセスの干渉）
- verify が abort された
- verify が失敗したが、**run 開始前の baseline で同じコマンドが既に失敗していた**（`verify.preExisting`）

この区別が無いと、連続失敗トリガが誤爆して正常な run を止めてしまう。

### verify のタイミング

- `executor.verifyMode: "per-ticket"`（既定）— native チケットごとにフル実行
- `executor.verifyMode: "final"` — 実行ループ後に1回だけ実行し、`done` を主張したチケットをまとめて昇格。
  分解された変更のように、途中チケット単体では tree が緑にならない計画向け。
- baseline は最初のチケットの前に1回。Supervisor にも `verify.baselineStatus` として渡る。

## 監査

- Supervisor には **フル ticket JSON**（acceptance / scope / branches / claim / evidence）
- 初回 audit は **fail-closed**（不正 JSON / 非0 exit → 実行しない）
- blocked / out-of-scope は即時 re-audit。ただし同一原因の blocked はまとめて1回
- 実行中の監査は `limits.maxSupervisions` で上限。初回と最終の監査は常に実行される
- **final の yellow は revise しない**。実行ループが既に終わっているため、revise が生む pending は
  永久に実行されない。findings として記録するだけ
- Primary への tool `content` は `buildPrimarySummary`（変更ファイル・tests・未解決を含む）

## Evidence スイープの範囲

`.git` は専用の control-plane snapshot が担当。filesystem snapshot は:

- cwd 配下を再帰（`evidence.ignoreDirNames` のディレクトリは**記録するが降りない**）
- cwd の親は**直下エントリのみ**（`evidence.parentMaxDepth` 既定 0）

依存・ビルド・キャッシュツリーと兄弟プロジェクトを外すのは、そこへの書き込みが Worker のもので
ないため。実際の強制は tool_call 時の scope-guard であり、このスイープは検出のバックストップ。
project 層は coverage を**広げる**方向にのみ変更できる。

## 設定

`default → repo → user → legacy project → folder project`
folder が legacy に勝つ。standards は優先度高い層を cap 内で優先保持。
読み込みに失敗した層は meta-loop を無効化し、理由を `/ml-doctor` に出す。

## UX / 実行モデル

- **TUI では orchestrate はデフォルト background** — tool は即 return、チャット継続可
- 完了時 `meta-loop-result` を `sendMessage({ followUp, triggerTurn })` で注入
- 起動時に verify 未設定・sfh write/full を警告（続行は可能）
- 停止: `/ml-stop`（AbortController）
- 状態: footer + **widget（belowEditor）** + `/tasks` `/ml-runs`。`/tasks <ticket-id>` で詳細
- board 永続化: `.pi/meta-loop/runs/<runId>/board.json` + `latest.json`。新しい20件まで保持
- 役サブプロセスの task は **stdin**（argv に載せない → Windows ENAMETOOLONG 回避）
- **終了セマンティクス**: `plan_failed` / 全 blocked → `incomplete` or `error`（偽の `done` にしない）
- plan は最大2回・outputCap≥200k、raw を `plan-attempt-*.txt` に保存
- アイドル時はポーラが盤面を読み直さない。owner lock の heartbeat は 15s（lease 60s）

## 既知の限界

- bash 個別 denylist は収束しないため、scoped native Worker では bash 自体を付与しない（built-in + scope + evidence）
- sfh write/full は OS sandbox なしでは scope を保証できないため拒否（read-only review のみ）
- sfh グループの完了判定は exit 0 + 非空 stdout。`integration.acceptance` は検証されない（native の
  決定論的 verify とは非対称。調査系タスク向けの割り切り）
- verify profile の承認は、対象リポジトリ自身のコードを実行する許可を意味する（SECURITY.md 参照）
- `limits.scopeCeiling` 未設定なら、書き込み範囲はモデル出力が決める
- background 中に Primary が同じ tree を編集すると Worker と衝突しうる。evidence の範囲を絞ったことで
  誤検出は大きく減ったが、`allowed_scope` 内の同じファイルを両者が触れば競合は残る
- チケット実行中の壁時計 Supervisor は未実装（チケット境界）
- nesting guard は協調的経路向け
- role/SFH subprocess は provider credentials のため host environment を継承する（値は doctor/log に出さない）
- クラッシュ後の run は session_start で `stopped` に落とす（自動再開なし）
- project config は access/tools/model を**広げられない**（user 層で ceiling を上げる）
