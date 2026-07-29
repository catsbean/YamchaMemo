import { Component, type ReactNode } from "react";

/** 화면이 무너졌을 때 마지막으로 한 번 저장을 시도하는 함수 */
export type Rescue = () => Promise<unknown>;

interface Props {
  children: ReactNode;
  /** 잡은 직후 실행 — 저장 안 된 글을 구해 낸다 */
  rescue?: Rescue;
}

interface State {
  error: Error | null;
  /** 구조 결과: null=시도 안 함, true=저장됨, false=실패 */
  rescued: boolean | null;
}

/** 렌더 중 예외를 받아내는 마지막 방어선.
 *
 *  React는 렌더에서 예외가 나면 트리를 통째로 언마운트한다. 경계가 없으면
 *  창이 흰 화면이 되고 쓰던 글이 그대로 사라진다. 여기서 잡아
 *  ① 저장 안 된 글을 먼저 구하고 ② 무슨 일이 났는지 보여 주고
 *  ③ 다시 시도할 길을 준다. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, rescued: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[YamchaMemo] 화면 오류:", error);
    const { rescue } = this.props;
    if (!rescue) return;
    rescue().then(
      () => this.setState({ rescued: true }),
      () => this.setState({ rescued: false }),
    );
  }

  render() {
    const { error, rescued } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-neutral-50 px-6 text-center">
        <h1 className="text-lg font-bold text-neutral-800">
          화면을 그리다 문제가 생겼습니다
        </h1>

        {this.props.rescue && (
          <p className="text-sm text-neutral-600">
            {rescued === null && "저장 안 된 내용을 저장하는 중…"}
            {rescued === true && "✅ 저장 안 된 내용은 저장했습니다."}
            {rescued === false &&
              "⚠️ 자동 저장에 실패했습니다. 아래 [다시 시도]로 돌아가 직접 저장해 보세요."}
          </p>
        )}

        <pre className="max-h-40 max-w-lg overflow-auto whitespace-pre-wrap rounded border border-neutral-200 bg-white p-3 text-left text-xs text-rose-600">
          {error.message}
        </pre>

        <div className="flex gap-2">
          <button
            className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-white hover:bg-neutral-600"
            onClick={() => this.setState({ error: null, rescued: null })}
          >
            다시 시도
          </button>
          <button
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:border-neutral-500"
            onClick={() => window.location.reload()}
          >
            앱 새로고침
          </button>
        </div>

        <p className="max-w-md text-xs text-neutral-400">
          메모는 모두 마크다운 파일로 저장돼 있어 앱을 다시 열어도 그대로
          있습니다.
        </p>
      </div>
    );
  }
}
