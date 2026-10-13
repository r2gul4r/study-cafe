# study-cafe 설계 참고 자료

2026-10-13 확인. GitHub 스타 수로 찾은 후보 중 요구사항에 맞는 원리를 골랐다. 아래 소스에서 확인한 동작과 study-cafe에 적용할 제안을 구분한다. 저장소 전체 실행·학습 효과 검증을 했다는 뜻은 아니다.

## 참고할 로직과 적용 방식

| 참고 프로젝트 | 소스에서 확인한 내용 | study-cafe에 적용할 설계 |
|---|---|---|
| DeepTutor | 탐색 → 문항별 계획 → 문항 생성·형식 검사, 유형별 수량 입력 | 먼저 25개 슬롯을 확정하고 기존 문제 선택·생성·검토를 분리. [출제 파이프라인](https://github.com/HKUDS/DeepTutor/blob/6cf793bd868ba5ecbe64722936d4be8fab5a01df/deeptutor/agents/question/pipeline.py) |
| OpenMAIC | 유형별 채점 로직, 생성 작업의 저장 지점·진행 이벤트·복구 | 객관식은 앱 규칙으로 채점. 조사·출제의 부분 결과와 완료 단계를 함께 저장하고 재개. [채점](https://github.com/THU-MAIC/OpenMAIC/blob/d725f19194606a01872cc6b2a142ef999217e33b/lib/quiz/grading.ts), [작업 실행기](https://github.com/THU-MAIC/OpenMAIC/blob/d725f19194606a01872cc6b2a142ef999217e33b/lib/server/generation/run/engine.ts) |
| Open Notebook | 원본 자료 추출·저장 후 변환 결과 연결. 인용은 자료·노트·인사이트 단위 | 원본과 가공 결과를 분리하고 출처를 유지. study-cafe는 문제 검토를 위해 페이지·문단·시간 범위까지 별도 설계. [자료 처리](https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/open_notebook/graphs/source.py), [인용 설명](https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/docs/3-USER-GUIDE/citations.md) |
| Anki | 카드별 복습 이력, 같은 노트에서 나온 관련 카드의 노출 조절 | 기록을 보존하고 비슷한 문제를 연속으로 맞힌 것을 독립 성공으로 과대 계산하지 않음. [복습 기록](https://github.com/ankitects/anki/blob/2f62b5e678079a4b163ec4f38cf0f8a7ea949852/rslib/src/revlog/mod.rs), [관련 카드 처리](https://github.com/ankitects/anki/blob/2f62b5e678079a4b163ec4f38cf0f8a7ea949852/rslib/src/scheduler/queue/builder/burying.rs) |
| Engram | 가르치는 대화와 분리된 평가 역할, 루브릭·답안 근거, 중복 평가 반영 방지 | 평가자에게 고정 기준과 제출 답안만 전달. 재채점으로 학습 횟수를 늘리지 않음. [평가자 지침](https://github.com/nagisanzenin/engram/blob/0590eb8f008680acbfb5aaa4dbc73bf63ca643dd/agents/engram-assessor.md) |
| ts-fsrs | TypeScript 복습 스케줄러와 복습 결과·로그 반환 API | 일정 계산용 후보. 문제 생성·개념 성취 판단은 앱의 별도 규칙. 도입 버전·파라미터는 P0에서 고정. [공식 저장소](https://github.com/open-spaced-repetition/ts-fsrs) |

위 적용 방식은 study-cafe의 설계 제안이다. 다른 프로젝트가 동일한 출제·성취·복구 규칙을 모두 구현했다는 뜻이 아니다.

## 그대로 적용하지 않는 부분

- OpenMAIC의 주관식 채점 경로에는 결과 JSON 해석 실패 시 배점의 절반을 반환하는 분기가 있다. study-cafe는 이를 보류로 처리해 미확정 점수를 분리한다. [해당 채점 경로](https://github.com/THU-MAIC/OpenMAIC/blob/d725f19194606a01872cc6b2a142ef999217e33b/app/api/quiz-grade/route.ts)
- Open Notebook의 자료 단위 인용만으로는 문제 정답을 검토할 구간이 충분히 드러나지 않을 수 있다. 원문 세부 위치를 연결하는 것은 이번 앱에 추가하는 설계다.
- 복습 등급의 Hard는 틀린 답에 주는 부분 점수가 아니다. Anki의 기준을 참고해 정답 여부와 사용자가 느낀 회상 난이도를 구분한다. [Anki 답안 등급 설명](https://docs.ankiweb.net/manual/studying#answer-buttons)
- 복습 간격만으로 새 상황에서의 적용 능력이 확인되지는 않는다. 변형 문제의 결과와 개념별 근거를 별도로 기록한다.

## 코덱스와 로컬 구현 근거

| 공식 자료 | 확인한 범위 | 설계에 반영한 판단 |
|---|---|---|
| [Codex App Server](https://learn.chatgpt.com/docs/app-server) | stdio 연결, 초기화, 계정·로그인, 스레드·턴, 진행·취소, 구조화 출력과 버전별 타입 | 로컬 어댑터 후보. 종료 알림의 성공 여부까지 검사. 실제 설치 버전으로 P0 검증 |
| [Codex 인증](https://learn.chatgpt.com/docs/auth) | Codex의 인증 방식과 인증 정보 관리 | 앱 DB·브라우저에 토큰을 복사하지 않는 지원 경로 사용 |
| [Sign in with ChatGPT 별도 연동 제약](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | 별도 로그인 연동 경로의 제약 | Codex 관리 인증 경로와 별도 자체 OAuth 구현을 혼합하지 않음 |
| [Vite 시작 문서](https://vite.dev/guide/) | 개발·빌드 환경과 런타임 요구 | 실제 개발 시작 시 지원 Node 버전과 패키지 버전 고정 |
| [Fastify 공식 문서](https://fastify.dev/docs/latest/) | Node 서버와 요청·응답 스키마 구성 | 로컬 API 후보, 도메인 규칙과 분리 |
| [SQLite FTS5](https://www.sqlite.org/fts5.html) | SQLite 전문 검색 확장 | 메타데이터 필터와 함께 초기 검색 후보. 한국어·일본어 품질은 별도 확인 |

공식 문서에 기능이 있다는 사실과 이 PC에서 지원 계정·버전으로 작동한다는 사실은 다르다. 현재 단계는 설계이며 설치·호출·자료 추출·학습 품질의 실제 확인은 [구현 계획](IMPLEMENTATION_PLAN.md)의 단계별 조건으로 남긴다.
