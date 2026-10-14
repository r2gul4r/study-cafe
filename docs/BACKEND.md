# 백엔드 API와 운영

백엔드 기본 주소: `http://127.0.0.1:4317`. 모든 `/api/*` 요청은 `Authorization: Bearer <session-token>` 헤더가 필요하다. 기본 Origin은 서버 포트와 개발용 5173의 localhost·127.0.0.1을 포함한다. 다른 프론트 주소를 사용하면 `STUDY_CAFE_ALLOWED_ORIGINS`에 정확한 origin으로 등록한다. 브라우저 인증 토큰을 URL query에 넣지 않는다.

## 처음부터 공부 한 회차까지

1. `POST /api/goals`에 `{"title":"파이썬 반복문"}`을 보내 목표 ID를 받는다.
2. `POST /api/goals/:id/plan`으로 목표·범위 초안을 받는다. 반환 job을 조회하고 사용자가 확인한 범위를 `POST /api/goals/:id/scopes`로 저장한다. 직접 범위를 입력해도 된다.
3. `POST /api/goals/:id/research`로 조사한다. 검색 후보·수집 상태·미확보 영역을 조회한다. 수집 근거가 확인되면 원문·정답표·문제 추출·검토까지 처리한다.
4. 사용자 자료는 `POST /api/sources`로 등록하고 `POST /api/sources/:id/ingest`에 텍스트 또는 PDF base64를 보낸다. URL 자료는 빈 객체를 보내 다운로드한다. 이후 `/extract-questions`를 호출하면 문항 추출과 검토를 수행한다.
5. `POST /api/exam-templates`에 `{"name":"기본 25문항"}`을 보내 객관식 20+주관식 5 구성을 만든다. 단일/복수 객관식과 주관식 수량을 각각 지정할 수 있다.
6. `POST /api/exams`에 `goalId`, `templateId`를 보낸다. `/api/exams/:id/prepare` 작업이 기존 문항 선택·부족분 생성·검토·시험 확정을 처리한다. 기존 문항이 이미 충분하면 `/finalize`로 확정할 수 있다.
7. `/api/exams/:id/attempts`로 시작한다. `/api/attempts/:id/answers/:slot`에 답과 기대 `version`을 PUT한다. 최초 버전은 0, 서버가 반환한 새 버전을 다음 수정에 사용한다.
8. `/api/attempts/:id/submit`에 고유 `requestId`를 보낸다. 객관식은 즉시 평가하고 주관식이 있으면 `gradingJobId`를 반환한다.
9. `/api/attempts/:id/result`에서 확정 득점·확정 배점·보류 수·최종 점수를 조회한다. 모든 문항 확정 전에는 `finalScore`가 null이다.
10. 목표의 `/wrong`, `/summarize`, `/notes`, `/reviews`, `/progress`로 학습 결과를 확인한다. 문제의 `/variant`로 변형 문제를 작성한다.

모든 POST 예시에서 본문이 없더라도 `{}` JSON을 보낸다. 정확한 입력 타입·경로 목록은 [OpenAPI](../openapi.json)를 따른다.

## 중요한 계약

| 기능 | 규칙 |
|---|---|
| 출처 정책 | `past_only`, `official_first`, `mixed`, `ai_only` |
| 부족한 기출 | `waiting_user`, `INSUFFICIENT_PAST`, 실제 부족 수 반환. 추가 자료를 넣고 작업 재개 또는 새 시험 구성 |
| 생성 근거 | 자료 구간의 정확한 인용이 필요. 목표 범위와 다른 개념·출처를 거부 |
| 문항 상태 | 등록은 `needs_review`, 검토를 거쳐 `usable`, 철회는 `retired` |
| 중복 | 파일 해시·정규화 문항 해시. 동일 문항의 여러 출처는 연결. 근접 변형은 에이전트 검토와 family 관계 사용 |
| 답안 저장 | 버전 충돌은 HTTP 409 `ANSWER_CONFLICT`. 서버의 버전과 답을 다시 읽고 사용자 선택 후 저장 |
| 제출 | 같은 requestId 재요청은 동일 결과. 다른 제출 ID로 중복 제출하면 409 |
| 시간 만료 | 서버 저장 종료 시각 기준. 재시작·조회·주기 검사에서 마지막 저장 답안을 제출 |
| 채점 실패 | pending. 점수를 0이나 절반으로 확정하지 않음 |
| 수동 평가 | 기대 평가 버전과 사유 필요. 과거 평가는 보존하고 새 버전 추가 |
| 정답 정정 | `/questions/:id/regrade`. 같은 본문·선택지·배점의 객관식은 새 정답으로 재평가. 내용·주관식 기준이 바뀌면 사용자 재검토 대기 |
| 복습 | ts-fsrs 5.4.2, 난수 fuzz 비활성화. 원본 기록으로 일정을 재계산. 힌트·같은 계열 같은 날 후속 결과는 일정 반영에서 제외 |
| 성취 | 다른 날 성공과 새 변형 성공을 함께 확인. 합격 확률이나 공식 환산점수로 해석하지 않음 |

`GET /api/exams/:id`와 응시 조회는 정답·루브릭·해설을 제외한다. 개인용 문제은행 관리 API에서는 정답을 볼 수 있다. 학습용 앱이며 PC 소유자에게 문제은행 접근을 막는 시험 보안 제품은 아니다.

## 작업과 이벤트

### 문항 수정·정정 API

- `GET /api/questions/:id/revisions`: 최신순 전체 수정 이력. 각 버전의 본문·정답·근거·검토 상태와 `createdAt`을 반환한다. 인증이 필요하다.
- `POST /api/questions/:id/revisions`: 문항 입력 필드와 `expectedRevisionId`를 보낸다. 읽기 응답의 `id`, `revisionId`, `version`, `status`, `review`, `createdAt`을 그대로 보내지 않는다. 기대 버전과 현재 버전이 다르면 409 `REVISION_CONFLICT`다. 기존 API 호환을 위해 기대 버전은 선택 필드지만 편집 UI는 항상 전송한다.
- 새 버전의 초기 상태는 `needs_review`. 원문·계열·근거를 보존하고 별도 `/review`로 검토를 확정한다.
- `/regrade`는 최신·`usable` 버전에만 허용한다. 이미 해당 버전으로 응시했거나 정정을 적용한 문항은 건너뛴다. 반환 `affected`의 `slot`은 1부터 시작한다.
- 수동 채점 이후에도 `correctionRevision`을 보존하여 같은 정정 재실행으로 사용자 결과를 덮어쓰지 않는다. 정정된 주관식의 보류 상태에는 예전 시험 기준의 AI 채점을 재적용하지 않는다.
- 결과의 `assessment.correctedAnswer`, `correctedExplanation`은 정정 후 표시용이다. 불변 시험 스냅샷과 구분해서 사용한다.

### 비동기 작업

AI·수집 작업은 HTTP 202와 job ID를 반환한다. `Idempotency-Key` 헤더를 사용하면 같은 요청의 중복 작업 생성을 방지한다. 같은 키로 다른 입력을 보내면 409다.

상태는 `queued`, `running`, `succeeded`, `waiting_user`, `paused`, `failed`, `cancelled`다. 실패·일시정지·입력 대기는 `/resume`으로 이어갈 수 있다. 취소는 다시 실행하지 않으며 새 작업을 만든다. 작업 입력은 재개 중 바뀌지 않는다.

- 상태: `GET /api/jobs/:id`
- 저장된 이벤트: `GET /api/jobs/:id/events?after=<sequence>`
- SSE: `GET /api/jobs/:id/stream`, 재연결 시 `Last-Event-ID` 헤더
- 제어: `POST /api/jobs/:id/pause`, `/cancel`, `/resume`

프론트에서는 Authorization 헤더를 넣을 수 있는 fetch stream으로 SSE에 연결한다. 작업 단계 결과와 체크포인트는 같은 DB 트랜잭션으로 저장한다. 모델 호출 자체는 장애 직전에 중복될 수 있지만 저장된 단계는 다시 반영하지 않는다. 학습 AI 작업은 한 번에 하나씩 수행한다.

## 자료와 오류

URL 수집은 http/https의 표준 포트만 사용한다. DNS로 확인한 공개 IP에 연결하고, 각 redirect도 다시 검사한다. localhost·사설망·클라우드 메타데이터 주소는 차단한다. 자료는 최대 20MB, PDF는 최대 300페이지다. HTML은 텍스트로 추출하고 원본은 attachment로만 전달한다.

출처 등록의 `rights`는 `link_only`, `allowed`, `user_provided`다. 직접 수집을 허용하려면 `rightsBasis`를 남긴다. 자동 조사에서는 명시적 이용 근거의 원문 인용이 실제 페이지에 있는지 확인한다. 로그인·유료 접근·본문 추출 실패는 상태와 사유로 남긴다. 스캔 PDF는 `OCR_REQUIRED`로 반환한다.

PDF는 원본 페이지 번호와 텍스트 위치를 저장한다. 정답표는 출처의 `answerSourceIds`로 연결한다. 문항에 필요한 지문은 `passage`와 `groupId`, 근거는 `evidence`의 segment ID와 정확한 인용으로 보존한다. 인용 연결은 정답 정확성을 보장하지 않으므로 검토 상태를 별도로 둔다.

## 백업과 복원

`POST /api/backups`는 SQLite 스냅샷과 그 스냅샷에 연결된 파일·해시 목록을 데이터 폴더의 `backups/<id>`에 만든다. `/api/backups/:id/verify`는 DB·첨부 해시와 참조 무결성을 검사한다.

복원은 서버를 종료한 상태에서 실행한다. 기존 데이터가 있으면 먼저 복원 전 백업을 만든다. 인증 토큰과 코덱스 자격 증명은 백업 대상이 아니다.

```sh
pnpm restore <backup-directory> <target-data-directory>
```

실행 중인 데이터 폴더는 잠금으로 복원을 거부한다. 백업 폴더 자체를 복원 대상으로 지정할 수 없다. 개인 기록과 원본 파일은 Git에 포함하지 않는다.

## 프론트 작업 전 확인

`/api/openapi.json`, 저장 충돌 409, 채점 보류 null, 작업 waiting_user·failed, 코덱스 미연결 상태를 화면에서 각각 처리해야 한다. 서버 종료 중에는 동작하지 않으며, 다시 시작하면 체크포인트에서 이어간다. 서버의 공식 학습 기록과 브라우저의 임시 미저장 답안은 저장 버전으로 구분한다.
