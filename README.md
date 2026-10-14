# study-cafe

로컬 코덱스와 함께 목표를 정하고, 자료를 조사하고, 시험을 풀고, 개념별 약점을 복습하는 개인 학습 시스템.

React·Vite 기반 한국어 프론트엔드와 TypeScript·Fastify·SQLite 백엔드를 로컬에서 함께 실행한다. 무료 MIT 템플릿의 탐색·목록·노트 구성을 참고했다. AI 기능은 설치된 Codex App Server와 기존 로그인으로 연결한다.

다른 컴퓨터에서 이어가기: [작업 현황과 인수인계](PROJECT_STATUS.md). 현재 구현·검증 범위, 다음 작업, 설치 및 데이터 복원 절차를 기록한다.

## 실행

Node.js 24 이상, pnpm 10.18.3, 로컬 Codex가 필요하다. 코덱스 연결 없이도 목표·자료 직접 등록·문제은행·시험·객관식 채점·기록·백업을 사용할 수 있다.

Windows PowerShell:

```powershell
cd C:\git\study-cafe
.\scripts\start.ps1
```

스크립트는 PATH의 Node/pnpm 또는 설치된 Codex 번들 런타임을 찾아 의존성 설치·빌드·실행한다. 일반 개발 환경에서는 다음 명령을 사용한다.

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/web install --frozen-lockfile
pnpm build
pnpm start
```

기본 주소는 `http://127.0.0.1:4317`이다. 데이터 기본 위치는 Windows의 `%LOCALAPPDATA%\study-cafe`이며 `STUDY_CAFE_DATA_DIR`로 변경할 수 있다. 데이터 폴더는 실행 코드·Git 저장소와 분리한다. 서버를 종료하려면 Ctrl+C를 누른다.

브라우저에서 기본 주소를 열고 `session-token` 파일 내용을 연결 화면에 입력한다. 토큰은 해당 탭의 세션에만 보관한다. 프론트 개발 시 백엔드 `pnpm dev`와 별도 터미널의 `pnpm dev:web`을 실행하고 `http://127.0.0.1:5173`에 접속한다.

API는 `/health`를 제외하고 로컬 세션 토큰이 필요하다. 토큰 파일의 값을 `Authorization: Bearer ...` 헤더에 넣는다. 토큰을 URL이나 Git에 넣지 않는다.

```powershell
$studyToken = (Get-Content "$env:LOCALAPPDATA\study-cafe\session-token" -Raw).Trim()
$studyHeaders = @{ Authorization = "Bearer $studyToken" }
Invoke-RestMethod http://127.0.0.1:4317/api/home -Headers $studyHeaders
```

코덱스 실행 파일을 자동으로 찾지 못하면 `CODEX_BIN` 환경 변수에 경로를 지정한다. 모델을 지정하려면 `/api/agent/models`에서 사용 가능한 후보를 확인한 뒤 `STUDY_CAFE_MODEL`을 설정한다. 계정 상태 조회와 실제 추론 성공은 별개이며 다음 검사로 실제 호출을 확인할 수 있다.

```sh
pnpm codex:probe
pnpm codex:probe --live
```

웹 검색과 온라인 추론에는 인터넷 및 사용 가능한 코덱스 계정이 필요하다. 앱은 인증 토큰을 복사하거나 별도 API 키를 요구하지 않는다. 로그인 시작 API는 지원되는 코덱스 관리 로그인 화면/디바이스 코드를 반환한다.

## 구현 범위

- 목표 생성·수정·보관, 범위 버전과 개념·비중, 에이전트 목표 초안.
- 웹 조사, 직접 URL·텍스트·PDF 등록, 다운로드·본문 추출, 정답표 연결, 출처·페이지·문단 근거 보존.
- 기존 문항 추출·독립 검토, 문제은행 검색·필터·수정 버전·보관, 중복 원문·문항 처리.
- 20·25·30문항 및 사용자 지정 템플릿, 영역별 구성표, 일반·약점·복습·실전 모드, 출처 정책, 부족분 출제.
- 불변 시험 스냅샷, 답안 버전 충돌 방지, 이어 풀기, 일반 학습 일시정지, 제한 시간·만료 제출.
- 객관식 채점, 기준별 주관식 평가, 보류·수동 정정, 정답표 수정에 따른 과거 응시 재채점.
- 오답·개념별 AI 요약, 변형 문제, FSRS 복습 일정, 같은 날·힌트·문제 계열별 근거 구분.
- SQLite 작업 체크포인트, 취소·일시정지·재개·재시작 복구, 멱등 요청, SSE 이벤트 재전송.
- 로컬 API 인증·Host/Origin 검사, URL 수집의 내부 주소 차단, 일관된 백업·검증·오프라인 복원.

스캔 PDF OCR·청해 재생·코드 실행 채점은 설계의 후속 확장 범위다. 지원하지 않는 자료는 오류 또는 보류 상태로 남긴다. 연구 작업은 조사 범위와 미확보 영역을 반환하며 인터넷 전체를 조사했다고 표시하지 않는다. 수집 가능 자료는 다운로드·문항 추출까지 처리하고, 이용 근거가 불명확한 자료는 링크로 남긴다.

## 검증과 문서

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm openapi
```

Windows에서는 `.\scripts\start.ps1 -Test`로 빌드와 테스트를 실행할 수도 있다. 실제 코덱스와 네트워크를 사용하는 별도 검사는 `node --import tsx scripts/live-smoke.ts`이며 `--full`을 붙이면 25문항을 검증한다. 계정 사용량을 소모한다. 자동 테스트의 AI 응답은 fixture이고 실제 모델 검증과 구분한다.

- [백엔드 API와 사용 흐름](docs/BACKEND.md)
- [프론트 화면·실행·검증 안내](docs/FRONTEND.md)
- [OpenAPI 명세](openapi.json) / 실행 중 `/api/openapi.json`
- [검증 기록](docs/VERIFICATION.md)
- [프로젝트 설계](docs/PROJECT_DESIGN.md)
- [학습 워크플로우](docs/WORKFLOWS.md)
- [원래 구현 계획](docs/IMPLEMENTATION_PLAN.md)
- [참고 프로젝트와 근거](docs/REFERENCES.md)

## 코드 구조

```text
src/core.ts        런타임 계약·기본 규칙
src/store.ts       SQLite 초기 마이그레이션·파일 저장
src/catalog.ts     목표·범위·출처·문제은행
src/sources.ts     공개 URL 다운로드·HTML/PDF 본문 추출
src/exams.ts       템플릿·구성표·선택·시험·답안
src/learning.ts    평가·정정·오답·복습·개념 상태
src/agent.ts       Codex JSON-RPC 어댑터
src/jobs.ts        작업 큐·체크포인트·취소·복구
src/workflows.ts   조사·추출·생성·검토·평가·요약 작업
src/backup.ts      백업·검증·복원·단일 프로세스 잠금
src/app.ts         인증·API·SSE·OpenAPI
src/main.ts        로컬 서버 시작
tests/            도메인·저장·HTTP·프로토콜 검증
```

백엔드는 `src/`, 프론트엔드는 `apps/web/`에 분리되어 있다. 프로덕션 빌드는 Fastify가 같은 로컬 주소에서 제공한다. 노트북 작업 브랜치는 `laptop`, 통합 기준 브랜치는 `develop`이다. 다른 컴퓨터의 미푸시 변경을 보존한 뒤 비교·통합한다.
