# vault-agent — Codex에게 위키의 일부만 맡기기

Obsidian 위키(마크다운 노트 폴더)를 Codex가 **직접 고치게** 하되, 네 가지 장치로 범위를 묶는다.

1. **선별** — 위키 전체가 아니라 씨앗 노트에서 `[[링크]]`를 따라간 노트, 메시지에 이름이 나온 노트, 최근 기록 N개만 고른다.
2. **샌드박스** — 고른 파일만 임시 폴더에 복사하고 `codex exec --sandbox workspace-write`를 그 폴더에만 돌린다.
3. **허용 목록** — 끝나면 허용 목록에 있는 파일만 위키로 돌려 쓴다. 읽기 전용 파일과 허용 폴더 밖 파일은 바뀌지 않는다.
4. **스냅샷** — 돌려 쓰기 직전 상태를 남겨 `undo` 한 번으로 되돌린다.

운동 기록 위키에서 시작했지만(텔레그램 한 문단 → 세션 노트·종목 노트·상태 노트 갱신), 날짜별 기록이 쌓이고 항목별 "현재 기준"이 따로 있는 위키라면 연구 노트·수업 노트·실험 기록에도 그대로 쓴다.

## 쓰는 법

ChatGPT Edu/Plus 등에 포함된 [Codex CLI](https://developers.openai.com/codex/cli)가 PATH에 있고 로그인돼 있어야 한다. Node 18 이상.

```powershell
# 1. 위키 루트에 설정 두 개를 놓는다 (예시를 복사해 고친다)
copy vault-agent.example.json  <위키>\vault-agent.json
copy instructions.example.md   <위키>\vault-agent.instructions.md

# 2. 어떤 파일을 읽고 고칠지 먼저 본다 (Codex를 돌리지 않는다)
node vault-agent.mjs plan --vault <위키> --seed "01_요일별루틴/2. 화_Pull_A.md" --message "턱걸이 5/5/4, 랫풀다운 30kg 10회 3세트"

# 3. Codex를 돌리되 반영하지 않고 diff만 본다
node vault-agent.mjs run  --vault <위키> --seed "..." --message "..." --dry-run

# 4. 반영한다 / 되돌린다
node vault-agent.mjs run  --vault <위키> --seed "..." --message "..."
node vault-agent.mjs undo --vault <위키>
```

`--vault`를 생략하면 현재 폴더가 위키다. `--date YYYY-MM-DD`로 기준 날짜를 바꾼다(기본은 오늘, Asia/Seoul).

## 설정 (`vault-agent.json`)

| 키 | 뜻 |
|---|---|
| `readableDirs` | Codex가 읽어도 되는 폴더. 이 밖의 파일은 임시 폴더에 복사되지 않는다 |
| `writableDirs` | 고쳐도 되는 폴더 (`readableDirs`의 부분집합). 개인정보·사진 폴더는 넣지 않는다 |
| `readOnly` | 매번 읽되 절대 고치지 않는 파일 (제약·주의사항) |
| `alwaysRead` | 씨앗과 무관하게 매번 읽는 파일 (상태 노트, 템플릿) |
| `keywordDirs` | 메시지에 파일 이름이 나오면 읽고 고칠 수 있게 할 폴더 (기본은 `writableDirs`) |
| `linkDepth` | 씨앗에서 링크를 몇 단계 따라갈지 (기본 1) |
| `recent` | `{ "dir", "limit" }` 최근 기록 몇 개를 함께 읽을지 |
| `newNote` | 새 기록 노트 이름. `{date}`와 `{seed}`(씨앗 노트 이름에서 정렬 번호를 뺀 것)를 쓴다. 그날 파일이 이미 있으면 그것을 쓴다 |
| `instructions` | Codex 지시문 파일. 그 뒤에 허용 목록·읽기 전용 목록·날짜·메시지가 자동으로 붙는다 |

## Codex 스킬로 설정하기

`.agents/skills/vault-agent/SKILL.md`를 `~/.codex/skills/vault-agent/`에 복사하면, 자기 위키에서 Codex에게 "이 위키에 vault-agent 붙여 줘"라고 말해 설정 파일 두 개를 만들고 `plan`·`--dry-run` 결과를 보게 할 수 있다. 스킬은 위키 노트를 고치지 않고, 실제 반영은 사용자가 `run`으로 한다.

## 테스트

```powershell
node --test vault-agent.test.mjs
```

## 설계 메모

- 경로는 모두 위키 루트 안인지 검사하고(`safeJoin`), 벗어나면 실행을 거부한다.
- 정본이 없는 이름으로는 새 파일을 만들지 않는다. 새로 생기는 파일은 `newNote` 하나뿐이다.
- 상시 서버·스케줄러가 없다. 사용자가 실행할 때만 돈다.
- Codex에 넘어가는 것은 임시 폴더의 파일과 지시문뿐이다. 위키 루트 경로나 설정 파일은 넘기지 않는다.
