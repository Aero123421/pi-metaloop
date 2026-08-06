---
name: meta-loop-setup
description: >-
  Explicitly set up pi-metaLoop for this machine and/or project.
  Use when the user asks to configure meta-loop, assign Orchestrator/Supervisor/Worker
  models, choose sfh tools/models/effort/access, write standards, or install/verify
  sfh and the extension. Invoke via /skill:meta-loop-setup. Do not run unsolicited.
---

# meta-loop-setup

ユーザーが**明示的に呼び出したときだけ**実行するセットアップスキル。  
pi-metaLoop（監督付き分業）を、このマシン / このプロジェクト向けに設定ファイルとして書き出す。

## ゴール

1. 拡張と **sfh（必須依存）** が入っているか確認する  
2. 対話で決める:
   - スコープ（user 全体 / このプロジェクト / 両方）
   - **roles**: orchestrator / supervisor / worker の model（と必要なら tools）
   - **sfh**: 使える tool 白リスト、tool 別 model / effort / access、統合ステップ設定
   - supervisor フック閾値、escalation、limits（任意）
   - プロジェクト standards.md（任意）
3. 設定を正しいパスに書き、要約を見せて確認を取る  
4. 動作確認のヒントを出す（`/tasks`、`orchestrate`、sfh version）

勝手に本番コードを書き換えない。設定ファイルと standards のみ。

---

## パス（必ず守る）

| 対象 | パス |
|------|------|
| ユーザー全体 config | `~/.pi/agent/meta-loop/config.json` |
| ユーザー standards | `~/.pi/agent/meta-loop/standards.md` |
| プロジェクト config | `<cwd>/.pi/meta-loop/config.json` |
| プロジェクト standards | `<cwd>/.pi/meta-loop/standards.md` |

Windows では `~` = ユーザーホーム（例: `C:/Users/<name>`）。

読み込み優先（後勝ち）: 拡張デフォルト → ユーザー → プロジェクト。

テンプレート:

- この skill 配下 `assets/user-config.template.json`
- `assets/project-config.template.json`
- `assets/standards.template.md`
- 詳細リファレンス: `references/config-schema.md`

---

## 手順

### 0. 前提チェック

```bash
# sfh（必須）
sfh --version

# 拡張が入っているか（settings の extensions / packages、または pi list）
```

- sfh が無い → インストールを案内してから続ける:
  - Windows: `irm https://github.com/Aero123421/SimpleFlowHarness/releases/latest/download/sfh-installer.ps1 | iex`
  - macOS/Linux: installer.sh（README 参照）
- 拡張が無い → `pi install git:github.com/Aero123421/pi-metaloop` またはローカル path を案内

可能なら `~/.pi/agent/models-store.json` や `auth.json` を**読んで**、利用可能な provider/model 候補をユーザーに提示する（無ければ手入力）。

### 1. スコープを聞く

`ctx.ui.select` 相当（対話）で:

1. **user のみ** — 全プロジェクト共通の役別モデル・sfh 既定  
2. **project のみ** — このリポジトリ固有（tool 白リストや基準向き）  
3. **両方** — user にモデル本命、project に上書き・白リスト・standards  

推奨: **両方**（モデルは user、プロジェクト制約は project）。

### 2. pi 役のモデル（roles）

それぞれ `provider/model-id`（pi の `/model` や `--model` と同じ形式）。空 = pi デフォルト継承。

聞く順:

| 役 | 推奨の考え方 | config キー |
|----|----------------|-------------|
| **Orchestrator** | 計画・分解が得意 | `roles.orchestrator.model` |
| **Supervisor** | 批判的・慎重（やや強め可） | `roles.supervisor.model` |
| **Worker** | 実装コスパ | `roles.worker.model` |

任意: 各役の `tools` 配列（通常はデフォルトのままでよい）。

### 3. sfh ハーネス（並列グループ用）

sfh は「調査 ∥ 探索 → 統合」の配管。ここでプロジェクトの**使える道具**を決める。

#### 3a. 許可 tool（白リスト）

`executor.sfhAllowedTools` — 空配列または省略 = 制限なし。  
プロジェクトでは絞るのが安全:

例: `["pi", "opencode"]`  
候補: `pi`, `opencode`, `codex`, `claude`, `grok`, `agy`, `cursor`（sfh がサポートするプリセット）

#### 3b. tool ごとの model / effort / access

| キー | 意味 |
|------|------|
| `executor.sfhToolModels.<tool>` | その tool の既定 model |
| `executor.sfhToolEfforts.<tool>` | effort（例: `low` / `medium` / `high` — **tool 依存**） |
| `executor.sfhToolAccess.<tool>` | `read` \| `write` \| `full`（調査は **read** 推奨） |
| `executor.sfhModel` | 全 sfh ステップの共通 model フォールバック |
| `executor.sfhEffort` | 共通 effort フォールバック |
| `executor.sfhAccess` | ブランチ既定 access（既定 `read`） |
| `executor.sfhIntegrateModel` | 統合ステップ model |
| `executor.sfhIntegrateEffort` | 統合 effort |
| `executor.sfhIntegrateAccess` | 統合 access（既定 `read`。書き込み統合は非推奨） |

解決順（ブランチ）:

```text
branches[].model|effort|access
  → sfhTool*(tool)
  → sfhModel / sfhEffort / sfhAccess
  → (model かつ tool=pi のとき) roles.worker.model
```

#### 3c. 並列・時間

- `executor.maxParallel`（既定 4）
- `executor.timeoutSec`（既定 1800）
- `executor.sfhBinary`（既定 `sfh`。PATH に無いときフルパス）

### 4. Supervisor / escalation（任意・既定のままでも可）

- `supervisor.checkIntervalMinutes`（30）
- `supervisor.workerStartThreshold`（6）
- `supervisor.maxConsecutiveFailures`（2）
- `escalation.enabled` と各 threshold（ソフトに orchestrate を勧めるだけ）

### 5. standards（任意）

プロジェクトの実装ルールがあれば `standards.md` を書く。  
テンプレ: `assets/standards.template.md`  
Supervisor の yellow/red 根拠になる。無い事項では excess 介入しない。

### 6. 書き込み

1. ディレクトリを作成（`mkdir -p` 相当）  
2. **既存ファイルがあれば read してマージ方針を確認**（上書き vs 追記）。破壊的上書きは確認後  
3. JSON は pretty-print（indent 2）  
4. 書いたパスを一覧表示  

### 7. 検証・クロージング

ユーザーに伝える:

```text
- 設定ファイル: <paths>
- 役モデル: orch=... / sup=... / worker=...
- sfh 許可 tools: ...
- 次の一手:
  1. pi を再起動 or /reload
  2. 長期タスクで「orchestrate で」と頼む、または長い作業を始める
  3. /tasks  /verdicts  /sfh
```

不要ならコミットしない（設定はユーザー環境のことが多い）。プロジェクトの `.pi/meta-loop/` をコミットするかはユーザーに聞く。

---

## 対話のトーン

- 一度に全部聞かない。スコープ → 役モデル → sfh → 任意、の順  
- 分からなければ「空 = デフォルト継承」を選ばせる  
- 調査ブランチの access を `write`/`full` にするときはリスクを一言添える  
- この skill は**設定ウィザード**であり、orchestrate 実行そのものではない  

## やってはいけないこと

- ユーザーが呼んでいないのにこの skill を走らせる  
- sfhAllowedTools を無断で全 tool + write にする  
- 既存の meta-loop config を確認なしで全消し  
- アプリのソースコードを「セットアップ」名目で改変する  
