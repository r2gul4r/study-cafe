import { useEffect, useState } from "react";
import {
  BookOpen,
  LayoutDashboard,
  Target,
  Library,
  Files,
  ClipboardList,
  NotebookPen,
  RotateCcw,
  Workflow,
  Settings,
  Menu,
  Search,
  ArrowUpRight,
  ShieldCheck,
  LogOut,
  Coffee,
} from "lucide-react";
import {
  api,
  go,
  TOKEN_KEY,
  useQuery,
  useRoute,
  initializeConnection,
  connectBrowser,
  message,
} from "./api";
import type { Goal, Home } from "./types";
import { Button, Heading, Loading, Notice, Empty, Badge } from "./ui";
import { Dashboard, Goals } from "./goals";
import { SourcesPage, Bank } from "./library";
import { ExamsPage, AttemptPage, ResultsPage } from "./exams";
import { NotesPage, ReviewsPage, JobsPage, SettingsPage } from "./learning";
const nav = [
  ["/", "학습 홈", LayoutDashboard],
  ["/goals", "내 목표", Target],
  ["/sources", "학습 자료", Files],
  ["/bank", "문제은행", Library],
  ["/exams", "시험과 기록", ClipboardList],
  ["/notes", "오답 노트", NotebookPen],
  ["/reviews", "복습 일정", RotateCcw],
  ["/jobs", "에이전트 작업", Workflow],
] as const;
export function App() {
  const route = useRoute(),
    pathname = route.split("?")[0];
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [connectionError, setConnectionError] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  useEffect(() => {
    let live = true;
    void initializeConnection()
      .then(() => {
        if (live) setConnected(true);
      })
      .catch((e) => {
        if (live && e.code !== "UNAUTHORIZED") setConnectionError(message(e));
      })
      .finally(() => {
        if (live) setConnecting(false);
      });
    return () => {
      live = false;
    };
  }, []);
  const retryConnection = async () => {
    setConnecting(true);
    setConnectionError("");
    try {
      await connectBrowser();
      setConnected(true);
    } catch (e) {
      setConnectionError(message(e));
    } finally {
      setConnecting(false);
    }
  };
  useEffect(() => {
    // A launcher may reuse an already-open tab and only change its hash.
    const launched = () => {
      if (location.hash.split("?")[0] === "#/connect") void retryConnection();
    };
    addEventListener("hashchange", launched);
    return () => removeEventListener("hashchange", launched);
  }, []);
  const [mobile, setMobile] = useState(false);
  const [narrow, setNarrow] = useState(
    matchMedia("(max-width: 760px)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(max-width: 760px)");
    const resize = () => setNarrow(media.matches);
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobile(false);
    };
    media.addEventListener("change", resize);
    addEventListener("keydown", escape);
    return () => {
      media.removeEventListener("change", resize);
      removeEventListener("keydown", escape);
    };
  }, []);
  const [goalId, setGoalId] = useState(
    localStorage.getItem("study-cafe-goal") ?? "",
  );
  const goals = useQuery<Goal[]>(connected ? "/goals" : null, 30000),
    home = useQuery<Home>(connected ? "/home" : null, 10000);
  useEffect(() => {
    const f = () => {
      sessionStorage.removeItem(TOKEN_KEY);
      setConnected(false);
    };
    addEventListener("study-cafe:unauthorized", f);
    return () => removeEventListener("study-cafe:unauthorized", f);
  }, []);
  useEffect(() => {
    setMobile(false);
    window.scrollTo(0, 0);
    const requestedGoal = new URLSearchParams(route.split("?")[1]).get(
      "goalId",
    );
    if (requestedGoal) setGoalId(requestedGoal);
  }, [route]);
  useEffect(() => {
    const loaded = goals.data;
    if (loaded)
      setGoalId((current) =>
        loaded.some((g) => g.id === current && !g.archived)
          ? current
          : (loaded.find((g) => !g.archived)?.id ?? ""),
      );
  }, [goals.data]);
  useEffect(() => {
    localStorage.setItem("study-cafe-goal", goalId);
  }, [goalId]);
  const select = (id: string) => setGoalId(id);
  const goal = goals.data?.find((g) => g.id === goalId);
  const refresh = () => {
    goals.reload();
    home.reload();
  };
  if (!connected)
    return (
      <div className="connect-page">
        <div className="connect-story">
          <div className="brand">
            <Coffee />
            <b>study-cafe</b>
          </div>
          <p className="eyebrow">YOUR PERSONAL STUDY SPACE</p>
          <h1>
            오늘의 공부가
            <br />
            내일의 실력이 되도록.
          </h1>
          <p>
            목표를 정하고, 문제를 풀고, 틀린 개념을 다시 만나세요.
            <br />
            나만의 학습 기록은 이 컴퓨터에 보관됩니다.
          </p>
          <div className="connect-steps">
            <span>01 목표 설정</span>
            <span>02 문제 풀이</span>
            <span>03 오답 복습</span>
          </div>
        </div>
        <section className="connect-card">
          <Badge>로컬 학습 공간</Badge>
          <h2>{connecting ? "공부방에 연결하고 있어요" : "내 공부방 열기"}</h2>
          {connecting ? (
            <Loading />
          ) : (
            <>
              <p className="muted">
                컴퓨터에서 공부방을 실행하면 자동으로 연결됩니다. 연결된
                브라우저는 30일 동안 기억해요.
              </p>
              {connectionError && <Notice>{connectionError}</Notice>}
              <p>프로젝트 폴더에서 실행해 주세요.</p>
              <pre>
                <code>{".\\scripts\\start.ps1"}</code>
              </pre>
              <details>
                <summary>서버가 이미 실행 중인가요?</summary>
                <p>
                  새 브라우저를 연결하거나 연결을 해제했다면 아래 명령으로 다시
                  열어 주세요.
                </p>
                <pre>
                  <code>{".\\scripts\\start.ps1 -Open"}</code>
                </pre>
                <p>
                  터미널에서는 <code>pnpm open</code>으로도 열 수 있어요. 서버와
                  같은 데이터 폴더 설정을 사용해 주세요.
                </p>
              </details>
              <Button onClick={() => void retryConnection()}>
                연결 다시 확인
              </Button>
            </>
          )}
          <div className="local-note">
            <ShieldCheck size={16} /> 클라우드 가입이나 결제 없이 연결
          </div>
        </section>
      </div>
    );
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        본문으로 건너뛰기
      </a>
      {mobile && (
        <button
          className="mobile-scrim"
          aria-label="메뉴 닫기"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        id="study-navigation"
        className={`sidebar ${mobile ? "open" : ""}`}
        inert={narrow && !mobile}
      >
        <a className="brand" href="#/">
          <span className="brand-icon">
            <Coffee size={21} />
          </span>
          <b>study-cafe</b>
        </a>
        <div className="workspace">
          <span className="workspace-avatar">나</span>
          <div>
            <strong>나의 공부방</strong>
            <small>개인 학습 공간</small>
          </div>
          <span className="online-dot" />
        </div>
        <p className="nav-caption">LEARNING SPACE</p>
        <nav>
          {nav.map(([path, name, Icon]) => (
            <a
              key={path}
              className={pathname === path ? "active" : ""}
              href={"#" + path}
            >
              <Icon size={18} />
              <span>{name}</span>
              {path === "/reviews" && !!home.data?.dueReviews && (
                <em>{home.data.dueReviews}</em>
              )}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <BookOpen size={20} />
            <strong>조금씩, 꾸준하게.</strong>
            <p>
              틀린 문제는 다음 공부의
              <br />
              좋은 출발점이에요.
            </p>
          </div>
          <a
            className={pathname === "/settings" ? "active" : ""}
            href="#/settings"
          >
            <Settings size={18} /> 설정
          </a>
          <button
            className="plain"
            disabled={disconnecting}
            onClick={async () => {
              setDisconnecting(true);
              setConnectionError("");
              try {
                await api("/browser/logout", "POST", {});
                sessionStorage.removeItem(TOKEN_KEY);
                setConnected(false);
              } catch (e) {
                setConnectionError(message(e));
              } finally {
                setDisconnecting(false);
              }
            }}
          >
            <LogOut size={16} /> 연결 해제
          </button>
          <small>LOCAL-FIRST · YOUR OWN PACE</small>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="row">
            <button
              className="icon-button mobile-menu"
              aria-expanded={mobile}
              aria-controls="study-navigation"
              aria-label="메뉴 열기"
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            <span className="muted">나의 공부방</span>
            <span className="crumb">/</span>
            <strong>
              {nav.find((n) => n[0] === pathname)?.[1] ??
                (pathname.startsWith("/attempt/")
                  ? "시험 풀이"
                  : pathname.startsWith("/result/")
                    ? "학습 결과"
                    : "설정")}
            </strong>
          </div>
          <div className="row top-tools">
            <form
              className="global-search"
              onSubmit={(e) => {
                e.preventDefault();
                go(
                  "/bank?search=" +
                    encodeURIComponent(
                      String(new FormData(e.currentTarget).get("search") ?? ""),
                    ),
                );
              }}
            >
              <Search size={16} />
              <input
                name="search"
                aria-label="문제 검색"
                placeholder="문제 검색…"
              />
            </form>
            <span className="connection">
              <i className={goals.error ? "offline" : "online-dot"} />
              {goals.error ? "연결 확인 필요" : "로컬 연결됨"}
            </span>
            <div className="profile-circle">나</div>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          {connectionError && <Notice>{connectionError}</Notice>}
          <div className="page-context">
            <span>
              <span className="status-dot" /> 나만의 학습 흐름을 만들어 보세요
            </span>
            <label>
              현재 목표{" "}
              <select
                aria-label="현재 목표"
                value={goalId}
                onChange={(e) => select(e.target.value)}
              >
                <option value="" disabled>
                  목표를 선택하세요
                </option>
                {goals.data
                  ?.filter((g) => !g.archived)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          {goals.error && (
            <Notice>
              {goals.error}{" "}
              <button className="text-link" onClick={refresh}>
                다시 연결
              </button>
            </Notice>
          )}
          {pathname === "/" ? (
            <Dashboard
              goals={goals.data ?? []}
              home={home.data}
              loading={home.loading}
              select={select}
            />
          ) : pathname === "/goals" ? (
            <Goals
              goals={goals.data ?? []}
              goal={goal}
              select={select}
              refresh={refresh}
            />
          ) : pathname === "/jobs" ? (
            <JobsPage refresh={refresh} />
          ) : pathname === "/settings" ? (
            <SettingsPage />
          ) : pathname.startsWith("/attempt/") ? (
            <AttemptPage id={pathname.split("/")[2]} />
          ) : pathname.startsWith("/result/") ? (
            <ResultsPage
              key={route}
              id={pathname.split("/")[2]}
              slot={
                Number(new URLSearchParams(route.split("?")[1]).get("slot")) ||
                undefined
              }
            />
          ) : goals.loading ? (
            <Loading />
          ) : !goal ? (
            <Empty
              title="먼저 학습 목표를 만들어 주세요"
              description="목표를 기준으로 자료와 문제, 복습 기록이 모입니다."
              action={
                <Button onClick={() => go("/goals")}>
                  첫 목표 만들기 <ArrowUpRight size={16} />
                </Button>
              }
            />
          ) : pathname === "/sources" ? (
            <SourcesPage key={goal.id} goal={goal} />
          ) : pathname === "/bank" ? (
            <Bank
              key={goal.id + route}
              goal={goal}
              search={
                new URLSearchParams(route.split("?")[1]).get("search") ?? ""
              }
            />
          ) : pathname === "/exams" ? (
            <ExamsPage key={goal.id} goal={goal} />
          ) : pathname === "/notes" ? (
            <NotesPage key={goal.id} goal={goal} />
          ) : pathname === "/reviews" ? (
            <ReviewsPage key={goal.id} goal={goal} />
          ) : (
            <Heading
              title="화면을 찾을 수 없어요"
              action={<Button onClick={() => go("/")}>학습 홈</Button>}
            />
          )}
        </main>
        <footer className="app-footer">
          <span>study-cafe · 배움이 쌓이는 공간</span>
          <span>학습 기록은 이 컴퓨터에 저장됩니다.</span>
        </footer>
      </div>
    </div>
  );
}
