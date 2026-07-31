# ticktick-td

터미널에서 TickTick 오늘 할일을 보고, 열고, 완료하고, 추가하는 CLI.
Windows · macOS · Linux 공용. **의존성 0**, 순수 Node ESM 으로 TickTick Open API v1 을 직접 호출한다.
인증만 공식 CLI([`@ticktick/ticktick-cli`](https://www.npmjs.com/package/@ticktick/ticktick-cli))에 맡긴다.

```
td                          오늘 마감인 할일
td 10                       미완료 전체를 우선순위·오래된 순으로 10개  (td top [N] 과 동일)
td view 1                   1번 항목의 상세 (내용·체크리스트·링크)
td open 1                   1번 항목의 링크를 기본 브라우저로 열기
td done 1 3                 방금 출력된 번호로 완료 처리
td add "장보기" --p high     할일 추가
td help                     도움말
```

```
  1.  !!!  step 강의                                     인박스 · 오늘
  2.       GeekNews - 개발/기술/스타트업 뉴스 서비스      인박스 · 오늘
  3.   !!  보고서 초안                                    Work · 오늘 14:00

지연 193건 · 미완료 전체 313건  →  td 10
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
| `td` | 오늘 마감인 미완료 항목. 시간 지정 항목이 먼저, 종일 항목이 뒤 |
| `td 10` / `td top [N]` | 미완료 전체를 우선순위 내림차순 → 등록일 오래된 순으로 N개 (기본 10) |
| `td view <번호>` | 상세: 마감·우선순위·태그·반복·체크리스트·본문·링크 목록 |
| `td open <번호>` | 첫 링크를 기본 브라우저로 연다. 링크가 없으면 TickTick 웹앱을 연다 |
| `td done <번호...>` | 완료 처리. 여러 개 가능 (`td done 1 3`) |
| `td add "<제목>" [옵션]` | 추가 |

`add` 옵션

| 옵션 | 값 |
| --- | --- |
| `--due` | `today` · `tomorrow` · `YYYY-MM-DD` · `"today 18:00"` · `"2026-08-05 09:30"` · `none` (기본: `today`) |
| `--p` | `high` · `med` · `low` · `none` |
| `--project` | 프로젝트 이름 (기본: 인박스) |

공통 옵션

| 옵션 | 설명 |
| --- | --- |
| `--json` | 서버 원본 태스크 JSON 출력 (목록·상세) |
| `--fresh`, `-f` | 캐시를 무시하고 서버에서 새로 받는다 |
| `NO_COLOR=1` | 색 끄기 |
| `NO_HYPERLINK=1` | 클릭 가능한 링크 끄기 |
| `TD_CONFIG_DIR` | 설정·캐시 저장 위치 (기본 `~/.config/td`) |
| `TD_CACHE_TTL_SEC` | 목록 캐시 유효 시간 (기본 300초, `0` 이면 캐시 안 함) |
| `TICKTICK_TOKEN` | 액세스 토큰 직접 지정 (공식 CLI 설정 파일보다 우선) |

## 동작 방식

- 액세스 토큰은 공식 CLI 가 `~/.config/ticktick-cli/config.json` 에 **평문**으로 저장한다. 커밋·공유 금지.
- 프로세스마다 TLS 핸드셰이크에만 1초 넘게 든다. 그래서 조회 결과를 `~/.config/td/task-cache.json` 에
  **5분간 캐시**한다 (첫 조회 약 1.4초 → 이후 약 0.3초). `td add` / `td done` 은 캐시를 무효화한다.
- `td done` 은 **완료 직전에 단건 조회로 제목을 대조**한다. 목록을 띄운 뒤 상황이 바뀌었으면 엉뚱한 항목을
  완료하지 않고 멈춘다. 이미 완료된 항목은 건너뛴다.
- 화면에 출력한 번호 → 태스크 매핑은 `~/.config/td/last-list.json` 에 저장되고 `td done` / `td view` / `td open`
  이 참조한다. 30분보다 오래된 목록으로 완료하려 하면 경고한다.
- 등록일 정렬은 `createdTime` 을 쓰고, 응답에 없으면 태스크 id(ObjectId) 앞 8자리에서 생성 시각을 복원한다.
- 링크는 **OSC 8 하이퍼링크**로 출력한다. Windows Terminal·iTerm2·VS Code 터미널 등에서 `Ctrl`(macOS 는 `Cmd`)
  + 클릭으로 열린다. 목록에서는 `[라벨](url)` 형태의 마크다운 링크를 라벨만 남기고 제목 전체를 링크로 감싼다.
- 제목 열 너비는 터미널 폭에 맞춰 20~60칸 사이로 조절된다. 한글은 두 칸으로 세어 열을 맞춘다.
- 파이프로 넘기거나 리다이렉트하면(TTY 가 아니면) 색·하이퍼링크 없이 순수 텍스트로 나온다.
- 종일 할일은 태스크의 `timeZone` 기준으로 달력 날짜를 계산한다. 서버는 종일 항목을 "해당 날짜의 로컬 자정"으로
  저장한다(KST 기준 `15:00Z`). `startDate == dueDate` 이므로 종료 시각 규칙은 쓰이지 않는다.

## Open API v1 의 실측 제약

`POST /task/filter` 를 직접 찔러 확인한 내용이다. 이 도구의 구조는 전부 여기서 나왔다.

| 관찰 | 대응 |
| --- | --- |
| `projectIds` 를 생략하면 **인박스만** 반환한다 (일반 프로젝트가 통째로 빠짐) | 일반 프로젝트는 `projectIds` 를 명시해 따로 조회하고 합친다 |
| 응답이 **200건에서 잘린다** (dueDate 내림차순으로 채움) | 인박스는 `endDate` 를 커서로 삼아 오래된 쪽으로 페이징한다 |
| `startDate`/`endDate` 는 dueDate 기준 `[start, end)` 범위다 | 페이징 커서로 사용 |
| **인박스의 기한 없는 태스크는 어떤 방법으로도 조회되지 않는다** (일반 프로젝트는 정상 반환) | `td add` 는 마감일을 생략하면 **오늘**로 잡는다. `--due none` 을 쓰면 경고를 띄운다 |
| `GET /project` 는 인박스를 반환하지 않는다 | 인박스 id 는 조회 결과에서 역으로 찾아 캐시한다 |
| `GET /project/{inbox}/data` 는 인박스 태스크의 일부만 준다 | 쓰지 않는다 (일반 프로젝트의 200건 초과 시 폴백으로만 사용) |
| `POST /task/search` 는 500 을 반환한다 | 쓰지 않는다 |

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

습관·포커스·댓글·칸반 등은 래핑하지 않았다. 필요할 때 직접 쓰면 된다:

```bash
npx -y @ticktick/ticktick-cli --help
```

## License

MIT
