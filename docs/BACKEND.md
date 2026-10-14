# 백엔드 API와 운영

백엔드 기본 주소: `http://127.0.0.1:4317`. 모든 `/api/*` 요청은 `Authorization: Bearer <session-token>` 헤더가 필요하다. 기본 Origin은 서버 포트와 개발용 5173의 localhost·127.0.0.1을 포함한다. 다른 프론트 주소를 사용하면 `STUDY_CAFE_ALLOWED_ORIGINS`에 정확한 origin으로 등록한다. 브라우저 인증 토큰을 URL query에 넣지 않는다.

## 처음부터 공부 한 회차까지

`GET /api/questions/:id/evidence?revisionId=<문항 버전>`은 인증 후 문항이 인용한 당시 자료를 반환한다. `sourceId`, `sourceRevisionId`, 제목, 수집 시각, 위치, 인용문, 저장 원문, 근거 역할(`question`/`answer`/`edition`/`support`)을 포함한다. 최신 자료로 교체하지 않으며 다른 문항의 버전 ID는 거부한다. 일반 응시용 문항에서는 근거·정답 연결 정보가 제외된다.

새 추출 문항의 `sourceMatch`는 문항/정답 번호와 각 인용, 판본 식별자와 양쪽 판본 인용을 기록한다. 별도 정답표는 동일 사이트라는 이유만으로 같은 판본으로 보지 않는다. 기존 레거시 문항과 사용자 등록에서는 이 필드가 없거나 null일 수 있다. AI 생성·변형은 null이다. 문항 수정 시 원문 연결을 유지하며 수정 내용의 정확성은 다시 검토해야 한다.

자료 후보 선택은 같은 목표의 수집 완료·이용 가능한 최신 구간에서 개념명 용어로 순위를 매긴다. 최대 8구간/48,000자이며 원문을 잘라 인용을 변형하지 않는다. 용어 일치가 없으면 자료별로 분산한 후보를 사용하고 이벤트에 `bounded_fallback`을 기록한다. 의미 검색·전체 자료 독해를 보장하지 않는다. 기존 문제 추출은 3구간씩 1구간을 겹쳐 처리하며 첫 구간과 연결 정답표 후보를 함께 제공한다.

`extract_questions` 결과는 `count`, `usable`, `needsReview`, `unresolved[{reference,reason}]`를 제공한다. 코드 검증에서 거부된 불완전 후보는 저장하지 않고 미해결 사유로 남긴다. 구조가 유효하지만 독립 검토가 불확실하면 `needs_review`로 저장한다. 생성 검토 3회 실패는 `waiting_user`/`GENERATION_REVIEW_REQUIRED`로 전환하며, 자료 보완 후 재개하면 완료된 슬롯은 유지하고 빈 슬롯만 다시 처리한다.

`GET /api/goals/:id/notes`의 각 개념에는 `references`가 포함된다. 각 항목은 `questionId`, `attemptId`, `slot`, `examTitle`, `submittedAt`, `conceptIds`, `segmentIds`를 제공한다. 요약에 저장된 `assessmentIds`와 개념의 `attemptIds`를 원래 시험 스냅샷에 대조하며 목표가 다른 기록은 제외한다. 현재 오답 목록이나 현재 문제은행 순서로 번호를 추측하지 않는다. 조회는 기존 note JSON을 수정하지 않는다.

주관식 통과 판정은 필수 채점 항목의 만점을 요구한다. 필수 항목이 하나도 없으면 전체 항목의 만점을 요구하며 빈 필수 집합 때문에 0점 답안을 통과시키지 않는다. 기준별 점수·답안 인용·통과 판정이 모순되면 저장하지 않고 실패/보류 상태를 유지한다.

주관식 자동 채점은 `audit_rubric` → `grade_answer` → 감점 후보의 `review_short_answer` 순서다. 첫 검토에는 학생 답안·모범답안을 주지 않고 고정 문제의 요구 문구와 기준을 대조한다. 새 문항의 `verify_question`에도 같은 `rubricCheck`를 요구해 불일치 문항은 사용 가능으로 승인하지 않는다. 기준의 ID·중복·정확한 문제 인용은 앱이 검사하지만 그 문구가 충분한 요구인지에 대한 판단은 모델에 의존한다.

`met`/`equivalent`는 기준 만점, `partial`은 0 초과 만점 미만, `missing`/`contradiction`은 0점이다. `uncertain` 또는 점수와 의미 판정의 모순은 보류한다. 감점 후보는 앞선 점수를 전달하지 않는 별도 평가와 항목별 점수·의미 판정을 대조한다. 두 평가가 다르면 평균을 내거나 한쪽을 임의로 확정하지 않는다. 구조·허위 인용 오류와 공급자 실패는 작업 실패로 남고 기존 보류 점수는 유지한다.

요구사항 검토·첫 채점·감점 재검토는 문항 슬롯과 평가 버전별 체크포인트로 저장한다. 같은 작업을 재개하면 완료 호출을 재사용하고 미완료 단계만 실행한다. 허위 인용·없는 기준 ID는 저장 전에 거부해 재개할 때 응답을 교체할 수 있다. 사용자 수동 평가와 정정 버전 보호는 그대로 적용한다.

결과의 `assessment.criteria`에는 선택적인 `verdict`가 추가되며 새 자동 평가에는 `gradingReview{policyVersion,rubricAudit,secondPass,issue}`를 보관한다. 기준 불일치/불확실/재검토 불일치는 설명과 함께 `pending`, score null이며 오답·복습에 반영하지 않는다. 과거 평가에는 이 필드가 없을 수 있다. `grade_attempt`는 미확정 자동 평가만 처리하고 수동 평가·문항 정정·확정 결과를 덮어쓰지 않는다. 과거 확정 점수는 기존 수동 평가 API로 정정할 수 있다.

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

- `POST /api/goals/:id/archive`에 `{ "archived": true }` 또는 `false`를 보내 보관/복원한다. 학습 기록과 진행 중 작업은 유지된다.
- `GET /api/goals/:id/deletion-preview`는 목표 이름, 삭제 대상별 `counts`, 실행 중 작업 여부 `blocked`, 확인 값 `confirmation`을 반환한다.
- `DELETE /api/goals/:id`에는 미리보기의 `confirmation`과 사용자가 확인한 `title`을 보낸다. 관련 자료·문항/버전·시험/응시/답안/채점·오답/복습·작업 로그를 외래 키를 유지하는 한 트랜잭션에서 삭제한다. 공용 첨부파일, 시험 템플릿, 기존 백업은 삭제하지 않는다.
- 관련 작업의 대기/실행/취소 후 종료 처리 중에는 409 `GOAL_BUSY`, 확인 이후 대상 기록 구성 변경에는 409 `GOAL_CHANGED`, 이름 불일치에는 400 `GOAL_TITLE`이다.

| 기능        | 규칙                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| 출처 정책   | `past_only`, `official_first`, `mixed`, `ai_only`                                                                           |
| 부족한 기출 | `waiting_user`, `INSUFFICIENT_PAST`, 실제 부족 수 반환. 추가 자료를 넣고 작업 재개 또는 새 시험 구성                        |
| 생성 근거   | 자료 구간의 정확한 인용이 필요. 목표 범위와 다른 개념·출처를 거부                                                           |
| 문항 상태   | 등록은 `needs_review`, 검토를 거쳐 `usable`, 철회는 `retired`                                                               |
| 중복        | 파일 해시·정규화 문항 해시. 동일 문항의 여러 출처는 연결. 근접 변형은 에이전트 검토와 family 관계 사용                      |
| 답안 저장   | 버전 충돌은 HTTP 409 `ANSWER_CONFLICT`. 서버의 버전과 답을 다시 읽고 사용자 선택 후 저장                                    |
| 제출        | 같은 requestId 재요청은 동일 결과. 다른 제출 ID로 중복 제출하면 409                                                         |
| 시간 만료   | 서버 저장 종료 시각 기준. 재시작·조회·주기 검사에서 마지막 저장 답안을 제출                                                 |
| 채점 실패   | pending. 점수를 0이나 절반으로 확정하지 않음                                                                                |
| 수동 평가   | 기대 평가 버전과 사유 필요. 과거 평가는 보존하고 새 버전 추가                                                               |
| 정답 정정   | `/questions/:id/regrade`. 같은 본문·선택지·배점의 객관식은 새 정답으로 재평가. 내용·주관식 기준이 바뀌면 사용자 재검토 대기 |
| 복습        | ts-fsrs 5.4.2, 난수 fuzz 비활성화. 원본 기록으로 일정을 재계산. 힌트·같은 계열 같은 날 후속 결과는 일정 반영에서 제외       |
| 성취        | 다른 날 성공과 새 변형 성공을 함께 확인. 합격 확률이나 공식 환산점수로 해석하지 않음                                        |

`GET /api/exams/:id`와 응시 조회는 정답·루브릭·해설을 제외한다. 개인용 문제은행 관리 API에서는 정답을 볼 수 있다. 학습용 앱이며 PC 소유자에게 문제은행 접근을 막는 시험 보안 제품은 아니다.

## 작업과 이벤트

### 문항 수정·정정 API

- `GET /api/questions/:id/revisions`: 최신순 전체 수정 이력. 각 버전의 본문·정답·근거·검토 상태와 `createdAt`을 반환한다. 인증이 필요하다.
- `POST /api/questions/:id/revisions`: 문항 입력 필드와 `expectedRevisionId`를 보낸다. 읽기 응답의 `id`, `revisionId`, `version`, `status`, `review`, `createdAt`을 그대로 보내지 않는다. 기대 버전과 현재 버전이 다르면 409 `REVISION_CONFLICT`다. 기존 API 호환을 위해 기대 버전은 선택 필드지만 편집 UI는 항상 전송한다.
- 새 버전의 초기 상태는 `needs_review`. 원문·계열·근거를 보존하고 별도 `/review`로 검토를 확정한다.
- `/regrade`는 최신·`usable` 버전에만 허용한다. 이미 해당 버전으로 응시했거나 정정을 적용한 문항은 건너뛴다. 반환 `affected`의 `slot`은 1부터 시작한다.
- 수동 채점 이후에도 `correctionRevision`을 보존하여 같은 정정 재실행으로 사용자 결과를 덮어쓰지 않는다. 정정된 주관식의 보류 상태에는 예전 시험 기준의 AI 채점을 재적용하지 않는다.
- 결과의 `assessment.correctedAnswer`, `correctedExplanation`은 정정 후 표시용이다. 불변 시험 스냅샷과 구분해서 사용한다.
- 제출된 결과와 오답에는 `explanationChoiceOrder`가 포함된다. 응시 당시 문항 버전(호환 가능한 정정이 적용되었다면 정정 버전)의 원래 보기 ID 순서다. `choices`, 제출 답안과 시험 스냅샷은 그대로 두고 해설 화면의 보기 표시만 이 순서를 따른다. 제출 전 공개 문항에는 이 필드와 해설을 제공하지 않는다.
- AI 생성·변형 문항은 보기 기호나 위치 대신 보기 내용을 인용하도록 지시한다. 기존 해설의 코드·수식·문장을 정규식으로 치환하지 않는다.

### 비동기 작업

AI·수집 작업은 HTTP 202와 job ID를 반환한다. `Idempotency-Key` 헤더를 사용하면 같은 요청의 중복 작업 생성을 방지한다. 같은 키로 다른 입력을 보내면 409다.

상태는 `queued`, `running`, `succeeded`, `waiting_user`, `paused`, `failed`, `cancelled`다. 실패·일시정지·입력 대기는 `/resume`으로 이어갈 수 있다. 취소는 다시 실행하지 않으며 새 작업을 만든다. 작업 입력은 재개 중 바뀌지 않는다.

Codex 최종 실패의 `error.details`는 알려진 `providerCode`, 유효한 `httpStatusCode`, 완료 상태만 보존한다. HTTP 429는 `CODEX_RATE_LIMITED`, 계정 사용량 한도는 `CODEX_USAGE_LIMIT`, 인증 실패는 `CODEX_AUTH_REQUIRED`로 안내한다. 원본 오류 메시지·추가 상세를 그대로 노출하지 않는다. 중간 연결 오류 후 성공한 turn은 정상 처리하며, 자동 무한 재시도나 유료 대체 연결은 없다.

목표 초안은 참고 URL을 절대 URL로만 출력하도록 지시하며 `AGENT_OUTPUT_INVALID`에 한해 오류 경로를 전달해 한 번 재시도한다. 재실패·연결 오류·취소는 그대로 보고한다. 초안은 사용자가 검토·저장하기 전에는 목표 범위에 적용하지 않는다.

자료 조사의 이용 근거는 내려받은 원문과 비교하며 HTML 추출로 생긴 공백·줄바꿈 차이만 정규화한다. 참고 문서(`reference`)는 출제 근거로 수집하되 기존 문제 자동 추출은 건너뛴다. 명시적인 문항 추출 요청 경로는 유지한다. 조사 응답의 `summary`는 실제 수집 결과로 구성하고 수집 전 모델 요약은 `discoverySummary`로 구분한다. 프론트는 과거 결과도 `outcomes`를 기준으로 수집 수를 표시한다.

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
