# ticktick-td

터미널에서 TickTick 할일을 보고, 열고, 완료하고, 추가하고, 편집하고, 지우는 CLI.
Windows · macOS · Linux 공용. **의존성 0**, 순수 Node ESM 으로 TickTick Open API v1 을 직접 호출한다.
인증만 공식 CLI([`@ticktick/ticktick-cli`](https://www.npmjs.com/package/@ticktick/ticktick-cli))에 맡긴다.

```
td                          오늘 마감인 할일 (모자라면 지난 항목으로 채움)
td 10                       미완료 전체를 우선순위·오래된 순으로 10개  (td top [N] 과 동일)
td view 1                   1번 항목의 상세 (내용·체크리스트·링크)
td open 1                   1번 항목의 링크를 기본 브라우저로 열기
td done 1 3                 방금 출력된 번호로 완료 처리
td add "장보기" --p high     할일 추가
td edit 1 --due tomorrow    편집 (옵션 없이 `td edit 1` 이면 에디터가 열린다)
td rm 2                     삭제 (확인을 묻는다)
td auth status              토큰 출처·권한·연결 확인
td help                     도움말
```

```
  1.  !!!  step 강의                                     인박스 · 오늘
  2.       GeekNews - 개발/기술/스타트업 뉴스 서비스      인박스 · 오늘
  3.   !!  보고서 초안                                    Work · 오늘 14:00

  ── 지난 항목 (141건 중 7건) ──

  4.  !!!  맨몸운동                                       인박스 · 1일 지남 (2026-08-06)
  5.       아트나우                                       Play Routine · 1일 지남 (2026-08-06)
  ...

지연 141건 · 미완료 전체 292건  →  td 10
```

## 설치

Node 20 이상 필요.

```bash
# 1) TickTick 로그인 — 브라우저가 열린다 (머신마다 1회)
npx -y @ticktick/ticktick-cli auth login

# 2) 설치
npm install -g ticktick-td      # td 명령 상시 사용
npx ticktick-td                 # 설치 없이 바로 실행
```

최신 main 을 바로 쓰려면:

```bash
npm install -g github:countnine/ticktick-td
```

npm 이 Windows 에선 `td.cmd` 셔임을, macOS·Linux 에선 심볼릭 링크를 만들어 주므로 어느 OS 에서나 사용법이 같다.
macOS 에서 권한 오류가 나면 sudo 대신:

```bash
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"   # ~/.zshrc 에 추가
```

브라우저를 쓸 수 없는 환경이면 TickTick 웹 → 아바타 → **Settings > Account > API Token** 발급 후:

```bash
npx -y @ticktick/ticktick-cli auth token <token>
```

## 명령

| 명령 | 설명 |
| --- | --- |
| `td` | 오늘 마감인 미완료 항목. 시간 지정 항목이 먼저, 종일 항목이 뒤. 10줄이 안 되면 지난 항목으로 채운다 |
| `td 10` / `td top [N]` | 미완료 전체를 우선순위 내림차순 → 등록일 오래된 순으로 N개 (기본 10) |
| `td view <번호>` | 상세: 마감·우선순위·태그·반복·체크리스트·본문·링크 목록 |
| `td open <번호>` | 첫 링크를 기본 브라우저로 연다. 링크가 없으면 TickTick 웹앱을 연다 |
| `td done <번호...>` | 완료 처리. 여러 개 가능 (`td done 1 3`) |
| `td add "<제목>" [옵션]` | 추가 |
| `td edit <번호> [옵션]` | 편집. 옵션이 하나도 없으면 `$EDITOR` 가 열린다 |
| `td rm <번호...>` | 삭제. 무엇을 지우는지 보여 주고 확인을 묻는다 (`-y` 로 생략). 휴지통에서 복구 가능 |
| `td auth status` | 토큰 출처·권한·연결 확인 (토큰은 끝 4자만 보여 준다) |
| `td auth fix-perms` | 토큰·캐시 파일 권한을 600/700 으로 조인다 (POSIX 전용) |

`add` 옵션

| 옵션 | 값 |
| --- | --- |
| `--due` | `today` · `tomorrow` · `YYYY-MM-DD` · `"today 18:00"` · `"2026-08-05 09:30"` · `none` (기본: `today`) |
| `--p` | `high` · `med` · `low` · `none` |
| `--project` | 프로젝트 이름 (기본: 인박스) |

`edit` 옵션 — 하나라도 주면 그 자리에서 반영하고, 하나도 없으면 에디터가 열린다

| 옵션 | 값 |
| --- | --- |
| `--title` | 제목 |
| `--due` | `add` 와 동일. `none` 이면 기한을 지운다 |
| `--p` | `add` 와 동일 |
| `--content` | 본문. 여러 줄은 에디터로 |

```
$ td edit 3 --due tomorrow --p high
✓ 3. 보고서 초안
    마감      2026-08-07 → 2026-08-08
    우선순위  없음 → 높음
```

프로젝트 이동은 넣지 않았다. Open API 가 `projectId` 변경을 **조용히 무시**하기 때문이다(아래 실측 표). 앱에서 옮겨야 한다.

공통 옵션

| 옵션 | 설명 |
| --- | --- |
| `--json` | 서버 원본 태스크 JSON 출력 (목록·상세) |
| `--fresh`, `-f` | 캐시를 무시하고 서버에서 새로 받는다 |
| `--fill <N>` | `td` 를 지난 항목으로 N줄까지 채운다 (기본 10, `0` 이면 끔) |
| `--yes`, `-y` | `td rm` 의 확인을 건너뛴다 |
| `NO_COLOR=1` | 색 끄기 |
| `NO_HYPERLINK=1` | 클릭 가능한 링크 끄기 |
| `TD_TODAY_FILL` | `--fill` 의 기본값 |
| `TD_EDITOR` | `td edit` 이 쓸 에디터. 없으면 `VISUAL` → `EDITOR` → `notepad`(Windows) / `vi` |
| `TD_CONFIG_DIR` | 설정·캐시 저장 위치 (기본 `~/.config/td`) |
| `TD_CACHE_TTL_SEC` | 목록 캐시 유효 시간 (기본 300초, `0` 이면 캐시 안 함) |
| `TICKTICK_TOKEN` | 액세스 토큰 직접 지정 |
| `TD_TOKEN_CMD` | 토큰을 출력하는 명령 (아래 "토큰과 보안") |

## 동작 방식

- `td` 는 오늘 마감을 먼저 세우고, **10줄이 안 되면 지난 항목으로 채운다.** 채우는 순서는
  **오늘에 가까운 날짜 먼저 → 같은 날짜 안에서 우선순위 높은 순 → 등록 오래된 순**이다.
  번호는 두 구역을 가로질러 이어지므로 `td done 7` `td rm 7` `td view 7` 이 화면의 7번을 그대로 가리킨다.
- `td edit` 은 **바뀐 필드만** 보낸다. Open API 의 편집은 부분 갱신이라 보내지 않은 태그·체크리스트·반복은
  서버가 그대로 둔다(실측). 그래서 제목만 고쳐도 나머지가 날아가지 않는다.
- `td edit` 을 옵션 없이 부르면 임시 파일(권한 600)을 에디터로 열고, 저장한 내용을 되읽어 반영한다.
  저장하지 않았거나 형식이 틀리면 아무것도 보내지 않는다. **형식이 틀린 경우 임시 파일을 지우지 않고 경로를 알려 준다.**
- `td rm` 은 지울 항목을 먼저 보여 주고 확인을 묻는다. 파이프·CI 처럼 대화형이 아니면 묻는 대신 `-y` 를 요구한다.
- 프로세스마다 TLS 핸드셰이크에만 1초 넘게 든다. 그래서 조회 결과를 `~/.config/td/task-cache.json` 에
  **5분간 캐시**한다 (첫 조회 약 1.4초 → 이후 약 0.3초). 목록을 바꾸는 명령(`add` · `done` · `edit` · `rm`)은
  캐시를 무효화한다.
- `td done` / `td rm` / `td edit` 은 **조작 직전에 단건 조회로 제목을 대조**한다. 목록을 띄운 뒤 상황이 바뀌었으면
  엉뚱한 항목을 건드리지 않고 멈춘다. `td done` 은 이미 완료된 항목을 건너뛴다.
- 편집으로 제목을 바꾸면 번호 캐시의 제목도 함께 갱신한다. 안 그러면 위 대조가 사용자 자신의 변경을 막는다.
- 화면에 출력한 번호 → 태스크 매핑은 `~/.config/td/last-list.json` 에 저장되고 번호를 받는 모든 명령
  (`view` · `open` · `done` · `edit` · `rm`)이 참조한다. 30분보다 오래된 목록으로 조작하려 하면 경고한다.
- 등록일 정렬은 `createdTime` 을 쓰고, 응답에 없으면 태스크 id(ObjectId) 앞 8자리에서 생성 시각을 복원한다.
- 링크는 **OSC 8 하이퍼링크**로 출력한다. Windows Terminal·iTerm2·VS Code 터미널 등에서 `Ctrl`(macOS 는 `Cmd`)
  + 클릭으로 열린다. 목록에서는 `[라벨](url)` 형태의 마크다운 링크를 라벨만 남기고 제목 전체를 링크로 감싼다.
- 제목 열 너비는 터미널 폭에 맞춰 20~60칸 사이로 조절된다. 한글은 두 칸으로 세어 열을 맞춘다.
- 파이프로 넘기거나 리다이렉트하면(TTY 가 아니면) 색·하이퍼링크 없이 순수 텍스트로 나온다.
- 종일 할일은 태스크의 `timeZone` 기준으로 달력 날짜를 계산한다. 서버는 종일 항목을 "해당 날짜의 로컬 자정"으로
  저장한다(KST 기준 `15:00Z`). `startDate == dueDate` 이므로 종료 시각 규칙은 쓰이지 않는다.

## 토큰과 보안

액세스 토큰은 공식 CLI 가 `~/.config/ticktick-cli/config.json` 에 **평문**으로 저장한다. 파일에는 `access_token`
하나뿐이고 refresh token 도 만료 시각도 없다 — 만료되면 재로그인이 유일한 방법이다. 커밋·공유 금지.

암호화를 내장하지 않았다. 위협별로 무엇이 실제로 막히는지 따져 보면 그렇다.

| 위협 | 평문이 문제인가 | 무엇이 막아 주나 |
| --- | --- | --- |
| 내 계정으로 도는 악성 프로그램 | 그렇다 | **아무것도.** 복호화 키에 똑같이 접근하므로 키체인·DPAPI 도 못 막는다 |
| 같은 기기의 다른 로컬 사용자 | macOS·Linux 에서 그렇다 (`~/.config` 755 + 파일 644) | 파일 권한 → `td auth fix-perms` |
| 백업·클라우드 동기화에 섞여 나감 | 그렇다 | 외부 비밀 관리자 → `TD_TOKEN_CMD` |
| 화면 공유·`cat` 실수 | 그렇다 | `td auth status` 는 끝 4자만 보여 준다 |
| Git 커밋 | 아니다 — 토큰은 프로젝트 밖에 있고 `files` 화이트리스트가 배포본을 막는다 | — |

Windows 에서는 토큰 파일이 사용자 프로필 ACL(`SYSTEM`·`Administrators`·본인)을 그대로 따르므로 모드 점검이
필요 없다. `td auth status` 도 그렇게 표시하고 추정으로 ✓ 를 찍지 않는다.

**`TD_TOKEN_CMD`** — 토큰을 출력하는 아무 명령이나 지정하면 평문 파일 없이 쓸 수 있다.

```bash
export TD_TOKEN_CMD='security find-generic-password -w -s ticktick'   # macOS keychain
export TD_TOKEN_CMD='op read op://Private/TickTick/token'             # 1Password CLI
export TD_TOKEN_CMD='pass show ticktick/token'                        # pass
```

- 우선순위는 `TICKTICK_TOKEN` → `TD_TOKEN_CMD` → 설정 파일이다. 설정하면 `~/.config/ticktick-cli/config.json` 을
  지워도 된다 (공식 CLI 의 `auth login` 은 다시 필요해질 때만 쓰면 된다).
- 표준출력의 **마지막 비어 있지 않은 줄**을 토큰으로 쓴다. 안내문을 함께 뱉는 도구도 그대로 물린다.
- 명령이 실패하면 종료 코드와 stderr 만 보여 준다. 표준출력과 명령 원문은 절대 인용하지 않는다
  (명령에 토큰을 직접 써 넣은 경우를 대비한 것이다).
- 쓰지 않으면 프로세스를 띄우지 않으므로 성능 영향이 없다. 쓰면 `td` 실행마다 그 명령이 한 번 돈다.

`~/.config/td/task-cache.json` 에는 **할일 제목이 들어 있다.** 이 도구가 쓰는 파일은 항상 0600 으로 만들지만,
예전에 만들어진 파일이나 공식 CLI 가 만든 파일은 `td auth fix-perms` 로 함께 조일 수 있다.

## Open API v1 의 실측 제약

직접 찔러 확인한 내용이다. 이 도구의 구조는 전부 여기서 나왔다.

| 관찰 | 대응 |
| --- | --- |
| `projectIds` 를 생략하면 **인박스만** 반환한다 (일반 프로젝트가 통째로 빠짐) | 일반 프로젝트는 `projectIds` 를 명시해 따로 조회하고 합친다 |
| 응답이 **200건에서 잘린다** (dueDate 내림차순으로 채움) | 인박스는 `endDate` 를 커서로 삼아 오래된 쪽으로 페이징한다 |
| `startDate`/`endDate` 는 dueDate 기준 `[start, end)` 범위다 | 페이징 커서로 사용 |
| **인박스의 기한 없는 태스크는 어떤 방법으로도 조회되지 않는다** (일반 프로젝트는 정상 반환) | `td add` 는 마감일을 생략하면 **오늘**로 잡는다. `--due none` 을 쓰면 경고를 띄운다 |
| `GET /project` 는 인박스를 반환하지 않는다 | 인박스 id 는 조회 결과에서 역으로 찾아 캐시한다 |
| `GET /project/{inbox}/data` 는 인박스 태스크의 일부만 준다 | 쓰지 않는다 (일반 프로젝트의 200건 초과 시 폴백으로만 사용) |
| `POST /task/search` 는 500 을 반환한다 | 쓰지 않는다 |
| `POST /task/{id}` 는 **부분 갱신**이다. 보내지 않은 `tags`·`content`·`items`·`priority`·`dueDate` 가 그대로 남는다 | `td edit` 은 바뀐 필드만 보낸다. 병합 페이로드가 필요 없다 |
| 편집 본문의 `projectId` 를 다른 값으로 바꿔도 **조용히 무시**된다 (오류도 없고 이동도 안 된다) | `td edit --project` 를 넣지 않았다 |
| `dueDate: null` 을 보내면 기한이 지워진다. 다만 **기한이 없는 동안 `repeatFlag` 가 빈 문자열로 온다** — 기한을 다시 넣으면 원래 규칙이 되살아난다 | `td edit --due none` 이 반복 항목이면 경고를 띄운다 |
| **삭제한 태스크도 단건 GET 은 성공**하고 `status` 도 `0` 그대로다 (목록에서는 즉시 사라진다) | 삭제 여부를 조회로 판정할 수 없다. `td rm` 은 성공한 항목을 번호 캐시에서 빼서 두 번째 시도를 걸러 낸다 |

## 종료 코드

| 코드 | 의미 |
| --- | --- |
| 0 | 성공 |
| 1 | API 오류 / 잘못된 인자 |
| 2 | 인증 없음 또는 토큰 만료 (재로그인 필요) |

## 개발

```bash
npm test              # node:test, 의존성 없음
npm run probe         # 응답 구조 진단 (제목 등 내용은 출력하지 않음)
node --check bin/td.mjs
```

CI 는 Windows·macOS·Linux × Node 20/22/24 에서 테스트를 돌린다.
릴리스는 `v*` 태그를 밀면 GitHub Actions 가 npm 에 발행한다 (provenance 포함).

## 공식 CLI 의 나머지 기능

습관·포커스·댓글·칸반·프로젝트 이동 등은 래핑하지 않았다. 필요할 때 직접 쓰면 된다:

```bash
npx -y @ticktick/ticktick-cli --help
```

## License

MIT
