import { IS_MAC, SHORTCUTS, shortcutText } from "../lib/shortcuts";

/** 설정 > 도움말 — 이 앱을 처음 쓰는 사람을 위한 사용법 안내.
 *  기능이 늘면 여기도 같이 손봐야 한다(설명이 실제와 어긋나면 없느니만 못하다). */
export default function HelpSection() {
  return (
    <div className="flex flex-col gap-6 text-sm leading-relaxed text-neutral-700">
      <Topic title="이 앱이 무엇인가">
        <p>
          메모는 전부 <B>마크다운(.md) 파일</B>로, 고르신 폴더(vault) 안에 그대로
          저장됩니다. 앱이 사라져도 파일은 남고, 다른 편집기로 열어도 됩니다.
          클라우드 동기화 폴더(OneDrive·iCloud·Dropbox 등)를 vault로 잡으면 기기
          사이에서 그대로 이어집니다.
        </p>
        <p>
          바깥(다른 앱)에서 파일을 고치면 앱이 알아채고 다시 읽어 옵니다. 편집
          중이라 자동으로 못 읽을 때는 노트 위에 알림 띠가 떠서 [다시 불러오기]와
          [내 편집 유지] 중에 고르게 합니다.
        </p>
      </Topic>

      <Topic title="분류 — 왼쪽 메뉴">
        <Dl
          items={[
            ["🏠 홈", "오늘 할 일·읽는 중인 책·최근 노트를 한 화면에 모아 봅니다."],
            ["📅 데일리노트", "하루에 한 장. 위 입력 바로 기록·느낌·할 일을 툭툭 던져 넣습니다."],
            ["📚 도서리스트", "책장. 검색으로 표지·저자까지 한 번에 등록합니다."],
            ["📖 독서기록", "책마다 쌓인 발췌·생각·요약·질문을 모아 봅니다."],
            ["✍️ 글쓰기", "원고. 시리즈로 묶어 연재물을 이어 쓸 수 있습니다."],
            ["📝 자유노트", "정리해 둘 그 밖의 메모. 참고 자료가 필요하면 [+ 분류 추가]로 나만의 분류를 만듭니다."],
            ["🏷️ 태그", "태그로 노트를 가로질러 봅니다."],
          ]}
        />
        <p>
          [+ 분류 추가]로 나만의 분류(예: 회의록, 레시피)를 만들 수 있습니다. 필요한
          입력칸과 새 노트 서식도 함께 정합니다.
        </p>
        <p>
          태그 칸 옆·태그 화면·담기 창에 뜨는 <B>제안 칩</B>은 <B>누른 것만</B>{" "}
          실제로 붙습니다. 아무것도 누르지 않으면 파일은 그대로입니다.
        </p>
        <p>
          제안은 이미 쓰는 태그, 다른 노트의 제목, 책의 저자·출판사 같이{" "}
          <B>이 서재가 이미 아는 이름</B>에서만 고릅니다. 그래서 새 책이나 노트를
          만들수록 제안이 좋아집니다. 호박색 칩은 이름이 아니라 그 이름이 속한{" "}
          <B>분야</B>입니다.
        </p>
      </Topic>

      <Topic title="일지 쓰는 법">
        <p>
          데일리노트를 열면 맨 위에 입력 바가 있습니다. 종류(<B>기록 · 느낌 · 할 일</B>
          )를 고르고 적은 뒤 <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> 또는 [추가]를 누르면
          바로 쌓입니다.
        </p>
        <Ul
          items={[
            "할 일은 체크박스로, 기록·느낌은 시각이 붙은 상자로 들어갑니다.",
            "할 일에 여러 줄을 적으면 줄마다 항목이 됩니다.",
            "쌓인 항목은 카드에서 바로 고치거나 지울 수 있습니다.",
            "종류 순서와 기본 선택은 설정 > 기록에서 바꿉니다. 맨 앞에 둔 것이 기본입니다.",
            "설정 > 기록에서 나만의 종류(예: 💡 아이디어)를 만들 수 있습니다 — 일지·독서기록 각각 5개까지.",
          ]}
        />
      </Topic>

      <Topic title="책과 독서기록">
        <p>
          도서리스트에서 [🔍 검색해서 추가]를 쓰면 제목만으로 저자·출판사·표지가
          채워집니다. 이미 있는 책들의 빈칸은 [✨ 자동 채우기]로 한 번에 메웁니다.
        </p>
        <p>
          책을 열면 정보 바(읽기 상태·별점·시작/완독일)를 그 자리에서 고칠 수 있고,
          아래 입력 바로 <B>발췌 · 생각 · 요약 · 질문</B>을 쌓습니다. 책 한 권이 곧
          독서기록 한 편입니다.
        </p>
      </Topic>

      <Topic title="노트끼리 잇기">
        <p>
          본문에 <Code>[[노트 제목]]</Code>이라고 쓰면 그 노트로 이어집니다.{" "}
          <Code>[[</Code>만 쳐도 제목이 자동완성되고, 서식 툴바의 🔗 또는{" "}
          <Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>K</Kbd>로도 넣을 수 있습니다.
        </p>
        <Ul
          items={[
            "이동: 링크를 우클릭해 [링크로 이동], 또는 Ctrl(⌘)+클릭. 기록 카드에서는 그냥 클릭하면 갑니다.",
            "노트 아래 백링크 칸에 '나를 가리키는 노트'가 문맥과 함께 나옵니다.",
            "[언급만] 탭에는 제목이 나오지만 아직 링크로 잇지 않은 노트가 모입니다.",
            "제목을 바꾸거나 다른 분류로 옮겨도 그 노트를 가리키던 링크는 함께 따라갑니다.",
          ]}
        />
        <p>
          노트마다 <B>별칭</B> 칸이 있습니다. <Code>프로헥사디온 칼슘</Code>에
          '비비풀'을 적어 두면 <Code>[[비비풀]]</Code>이라고 써도 그 노트가 열리고,
          백링크에도 함께 잡힙니다. 쉼표로 여러 개를 둘 수 있습니다.{" "}
          <B>같은 이름의 글이 따로 있으면 그 글이 우선</B>입니다 — 별칭이 남의
          제목을 가로채지 않습니다.
        </p>
        <p>
          별칭은 <B>검색으로도 찾힙니다</B> — 오타나 초성(<Code>ㅂㅂㅍ</Code>)으로도
          걸립니다. 다만 같은 이름의 글에 가려 쓰이지 않는 별칭은 입력칸이 그 자리에서
          알려 줍니다.
        </p>
        <p>
          이름이 겹치는 노트가 여럿이면(자유노트와 회의록에 '중복노트'가 하나씩)
          링크를 눌렀을 때 <B>어느 글인지 고르는 창</B>이 뜹니다(<Kbd>↑</Kbd>
          <Kbd>↓</Kbd>·<Kbd>Enter</Kbd>·번호키). 늘 한쪽으로 가게 하려면 링크에
          폴더를 함께 적으세요 — <Code>[[회의록/중복노트]]</Code>.{" "}
          <Code>[[</Code> 자동완성에서 고르면 겹치는 이름은 폴더까지 저절로
          들어갑니다.
        </p>
        <p>
          아직 없는 글로 이어진 링크를 누르면 알림이 잠깐 떴다가 스스로 사라집니다.
          알림의 [만들기]를 누르면 그 이름으로 글을 만들어 바로 엽니다(설정 &gt;
          일반에서 끌 수 있습니다).
        </p>
      </Topic>

      <Topic title="마크다운 문법">
        <p className="text-neutral-500">
          문법을 몰라도 됩니다 — 서식 툴바나 우클릭 메뉴로 다 넣을 수 있습니다.
          직접 치는 게 빠른 분을 위한 표입니다.
        </p>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-neutral-500">
              <th className="py-1 pr-3 font-medium">이렇게 쓰면</th>
              <th className="py-1 font-medium">이렇게 됩니다</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["# 제목", "가장 큰 제목 (##, ### 로 작아집니다)"],
              ["**굵게**", "굵은 글씨"],
              ["*기울임*", "기울어진 글씨"],
              ["~~취소선~~", "가운데 줄이 그어진 글씨"],
              ["`코드`", "고정폭 글씨"],
              ["- 항목", "글머리 목록"],
              ["1. 항목", "번호 목록"],
              ["- [ ] 할 일", "체크박스 (눌러서 완료 표시)"],
              ["> 인용", "왼쪽에 선이 붙은 인용"],
              ["[[노트 제목]]", "다른 노트로 가는 링크"],
              ["[보이는 글자](주소)", "웹 링크"],
              ["![](이미지 경로)", "이미지 (그림을 붙여넣으면 자동으로 들어갑니다)"],
              ["#태그", "태그 (frontmatter의 tags와 같이 취급됩니다)"],
              ["> [!기록] 09:30", "기록 상자 (툴바의 🕘로 만드는 것이 편합니다)"],
            ].map(([syntax, result]) => (
              <tr key={syntax} className="border-b border-neutral-100 align-top">
                <td className="py-1 pr-3">
                  <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-2xs text-neutral-700">
                    {syntax}
                  </code>
                </td>
                <td className="py-1 text-neutral-600">{result}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Topic>

      <Topic title="단축키">
        <p className="text-neutral-500">
          {IS_MAC ? "맥에서는 ⌘" : "윈도우·리눅스에서는 Ctrl"}을 씁니다. 켜고 끄기는
          설정 &gt; 일반에서 합니다.
        </p>
        <ul className="flex flex-col gap-1">
          {SHORTCUTS.map((s) => (
            <li key={s.id} className="flex items-baseline gap-2">
              <kbd className="shrink-0 rounded border border-neutral-300 bg-neutral-50 px-1.5 py-0.5 font-mono text-2xs text-neutral-700">
                {shortcutText(s)}
              </kbd>
              <span className="text-xs">{s.label}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-neutral-500">
          편집 중에는 <Kbd>Ctrl</Kbd>+<Kbd>B</Kbd> 굵게, <Kbd>Ctrl</Kbd>+<Kbd>I</Kbd>{" "}
          기울임, <Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>C</Kbd> 코드,{" "}
          <Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>K</Kbd> 노트 연결도 씁니다.
        </p>
      </Topic>

      <Topic title="잃어버리지 않게 하는 장치들">
        <Dl
          items={[
            ["자동 저장", "마지막 타자 3초 뒤에 저장합니다. 창을 닫을 때도 저장하고 닫습니다."],
            ["기록 보관", "저장할 때마다 이전 판을 남깁니다. 노트 위 [기록] 버튼에서 되돌릴 수 있습니다(기본 20판)."],
            ["휴지통", "지운 노트는 바로 사라지지 않습니다. 왼쪽 아래 [🗑️ 휴지통]에서 되살립니다(기본 7일 보관)."],
            ["미러", "설정 > 저장에서 복제 폴더를 걸어 두면 저장할 때마다 사본을 만듭니다."],
            ["점검", "규격에서 벗어나 목록에 안 보이는 파일이 있으면 왼쪽 아래에 [⚠️ 점검]이 뜹니다. 대부분 눌러서 고칠 수 있습니다."],
          ]}
        />
      </Topic>

      <Topic title="이럴 땐">
        <Dl
          items={[
            ["목록에 같은 제목이 둘", "파일명이 달라서 뒤에 흐린 (2)가 붙습니다. 서로 다른 노트입니다."],
            ["노트를 다른 분류로 옮기고 싶다", "목록에서 우클릭해 [○○로 이동], 또는 노트를 열고 오른쪽 위 [이동]. 옮긴 직후 알림의 [되돌리기]로 물릴 수 있습니다. 도서리스트·데일리노트는 파일명 규칙이 정해져 있어 옮길 수 없습니다."],
            ["새 창에서 링크를 눌렀다", "그 글의 새 창이 열립니다(이미 열려 있으면 앞으로 나옵니다). 보던 글이 바뀌지 않도록 일부러 그렇게 했습니다."],
            ["노트가 목록에 안 보인다", "[⚠️ 점검]을 확인하세요. 그래도 없으면 설정 > 저장의 [다시 색인]을 눌러 보세요."],
            ["한 노트를 따로 띄우고 싶다", "목록에서 Ctrl(⌘)+클릭하거나 노트 오른쪽 위 ⧉를 누르면 새 창으로 열립니다."],
            ["일지에서 원문을 직접 고치고 싶다", "노트 오른쪽 위 [원문 편집]을 누르면 마크다운이 그대로 나옵니다."],
          ]}
        />
      </Topic>
    </div>
  );
}

function Topic({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-neutral-800">{title}</h3>
      {children}
    </section>
  );
}

function Ul({ items }: { items: string[] }) {
  return (
    <ul className="ml-4 list-disc space-y-1 text-xs text-neutral-600 marker:text-neutral-300">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

function Dl({ items }: { items: [string, string][] }) {
  return (
    <dl className="flex flex-col gap-1.5">
      {items.map(([term, desc]) => (
        <div key={term} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
          <dt className="shrink-0 text-xs font-medium text-neutral-700 sm:w-32">
            {term}
          </dt>
          <dd className="min-w-0 text-xs text-neutral-600">{desc}</dd>
        </div>
      ))}
    </dl>
  );
}

const B = ({ children }: { children: React.ReactNode }) => (
  <strong className="font-semibold text-neutral-800">{children}</strong>
);

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-2xs text-neutral-700">
    {children}
  </code>
);

const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="rounded border border-neutral-300 bg-neutral-50 px-1 py-0.5 font-mono text-3xs text-neutral-600">
    {children}
  </kbd>
);
