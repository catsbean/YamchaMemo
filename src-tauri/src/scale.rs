//! 1만 편 규모 실측용 합성 vault (8-3).
//!
//! `YAMCHA_SCALE_DIR=<빈 폴더> cargo test -p yamcha-app --lib scale_vault_gen -- --ignored --nocapture`
//!
//! 노트 1만 편(일지 3,000 · 자유 4,000 · 책 800 · 글쓰기 500 · 사용자 분류 1,700)과 첨부 약 2GB를 만든다.
//! 실제 vault처럼 — 링크(모두가 가리키는 허브 노트 하나 포함)·태그·할 일·콜아웃·책 표지, 수정시각을
//! 8년에 걸쳐 흩어 둔다(frontmatter `date`도 같은 날로). 같은 씨앗이면 늘 같은 vault가 나온다.
//!
//! **저장소 안에 만들지 않는다** — 2GB다. 만들기 전에 그 드라이브의 여유를 볼 것(`HANDOFF.md` §7-48).

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // 빈 폴더에 새로 쓰는 시험 데이터 — 원자적 쓰기가 필요 없다
mod tests {
    use std::collections::HashSet;
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    /// 결정적인 난수 (xorshift64*) — 같은 씨앗이면 같은 vault
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
        fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
            &xs[self.below(xs.len())]
        }
        fn chance(&mut self, percent: usize) -> bool {
            self.below(100) < percent
        }
    }

    const WORDS: &[&str] = &[
        "사과", "바다", "기억", "도시", "시간", "사람", "여행", "책상", "커피", "음악", "그림", "편지", "회의", "계획",
        "정리", "공부", "운동", "산책", "저녁", "아침", "주말", "가족", "친구", "학교", "회사", "프로젝트", "디자인",
        "코드", "버그", "배포", "서버", "데이터", "검색", "색인", "노트", "메모", "일기", "독서", "발췌", "요약",
        "질문", "생각", "느낌", "기록", "할일", "마감", "예산", "보고서", "발표", "자료", "문서", "사진", "영상",
        "강의", "세미나", "워크숍", "인터뷰", "고객", "제품", "시장", "경쟁", "전략", "목표", "성과", "리뷰", "피드백",
        "개선", "실험", "가설", "결과", "분석", "통계", "그래프", "모델", "알고리즘", "구조", "설계", "패턴", "원칙",
        "철학", "역사", "과학", "문학", "소설", "시집", "에세이", "고전", "신학", "경제", "정치", "사회", "문화",
        "예술", "건축", "요리", "레시피", "정원", "식물", "고양이", "강아지", "하늘", "구름", "비", "눈", "바람",
        "봄", "여름", "가을", "겨울", "서울", "부산", "제주", "한강", "산", "숲", "길", "다리", "창문", "문",
        "Rust", "Tauri", "React", "Obsidian", "Markdown", "SQLite", "tantivy",
    ];
    const GENRES: &[&str] = &["소설", "에세이", "고전", "역사", "과학", "경제", "신학", "컴퓨터/IT", "예술", "자기계발"];
    const SERIES: &[&str] = &["봄날의 기록", "개발 일지", "여행 산문", "읽고 쓰기", "작은 철학"];
    const PEOPLE: &[&str] = &["민수", "지영", "현우", "서연", "도윤", "하은", "준호", "수빈", "예린", "태민"];

    fn sentence(r: &mut Rng) -> String {
        let n = 5 + r.below(9);
        let words: Vec<&str> = (0..n).map(|_| *r.pick(WORDS)).collect();
        format!("{}.", words.join(" "))
    }

    fn paragraph(r: &mut Rng, sentences: usize) -> String {
        (0..sentences).map(|_| sentence(r)).collect::<Vec<_>>().join(" ")
    }

    /// 겹치지 않는 제목
    fn title(r: &mut Rng, taken: &mut HashSet<String>) -> String {
        loop {
            let n = 2 + r.below(2);
            let t = (0..n).map(|_| *r.pick(WORDS)).collect::<Vec<_>>().join(" ");
            let t = if taken.contains(&t) { format!("{t} {}", r.below(1000)) } else { t };
            if taken.insert(t.clone()) {
                return t;
            }
        }
    }

    fn tags(r: &mut Rng) -> String {
        let n = r.below(4);
        let ts: Vec<String> = (0..n).map(|_| format!("태그{}", r.below(150))).collect();
        format!("[{}]", ts.join(", "))
    }

    /// 2018-01-01 ~ 2026-09-30 사이 아무 날
    fn some_day(r: &mut Rng) -> (String, SystemTime) {
        let start = 1_514_764_800u64; // 2018-01-01
        let end = 1_790_726_400u64; // 2026-09-30
        let secs = start + r.next() % (end - start);
        let t = UNIX_EPOCH + Duration::from_secs(secs);
        let date = chrono::DateTime::from_timestamp(secs as i64, 0)
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        (date, t)
    }

    fn write(path: &Path, text: &str, mtime: Option<SystemTime>) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = File::create(path).unwrap();
        f.write_all(text.as_bytes()).unwrap();
        if let Some(t) = mtime {
            f.set_modified(t).unwrap();
        }
    }

    fn random_file(path: &Path, r: &mut Rng, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = std::io::BufWriter::new(File::create(path).unwrap());
        let mut left = bytes;
        let mut buf = [0u8; 8192];
        while left > 0 {
            for chunk in buf.chunks_mut(8) {
                chunk.copy_from_slice(&r.next().to_le_bytes()[..chunk.len()]);
            }
            let n = left.min(buf.len());
            f.write_all(&buf[..n]).unwrap();
            left -= n;
        }
    }

    fn links(r: &mut Rng, titles: &[String], max: usize) -> String {
        let n = r.below(max + 1);
        (0..n).map(|_| format!("[[{}]]", r.pick(titles))).collect::<Vec<_>>().join(" ")
    }

    #[test]
    #[ignore]
    fn scale_vault_gen() {
        let root = PathBuf::from(std::env::var("YAMCHA_SCALE_DIR").expect("YAMCHA_SCALE_DIR=<빈 폴더>"));
        if root.exists() {
            assert!(fs::read_dir(&root).unwrap().next().is_none(), "빈 폴더여야 한다: {}", root.display());
        }
        let started = Instant::now();
        let mut r = Rng(0x5EED_1A2B_3C4D_5E6F);
        let mut taken = HashSet::new();

        // 제목을 먼저 정한다 — 링크가 서로를 가리킬 수 있게
        let free: Vec<String> = (0..4000).map(|_| title(&mut r, &mut taken)).collect();
        let books: Vec<String> = (0..800).map(|_| title(&mut r, &mut taken)).collect();
        let writing: Vec<String> = (0..500).map(|_| title(&mut r, &mut taken)).collect();
        let meetings: Vec<String> = (0..1700).map(|_| format!("회의 {}", title(&mut r, &mut taken))).collect();
        let all: Vec<String> = free.iter().chain(&books).chain(&writing).cloned().collect();
        let hub = "허브 노트".to_string();

        // 사용자 분류 — 참석자(여러 값, 목록에 보임)·단계(고르기)
        write(
            &root.join("_types.json"),
            r#"[{"id":"회의록","label":"회의록","folder":"회의록","fields":[
{"name":"date","label":"날짜","kind":"date","required":true,"options":[],"option_labels":[]},
{"name":"tags","label":"태그","kind":"tags","required":true,"options":[],"option_labels":[]},
{"name":"attendees","label":"참석자","kind":"tags","required":false,"options":[],"option_labels":[],"in_list":true},
{"name":"stage","label":"단계","kind":"select","required":false,"options":["준비","진행","끝"],"option_labels":[]}
],"template":"","builtin":false}]"#,
            None,
        );

        // 허브 — 600편이 가리킨다
        write(
            &root.join("Free").join(format!("{hub}.md")),
            &format!("---\ntitle: {hub}\ntype: free\ntags: [허브]\n---\n\n{}\n", paragraph(&mut r, 6)),
            None,
        );

        for (i, t) in free.iter().enumerate() {
            let (date, mtime) = some_day(&mut r);
            let mut body = String::new();
            for _ in 0..(1 + r.below(4)) {
                let n = 4 + r.below(8);
                body.push_str(&paragraph(&mut r, n));
                body.push_str("\n\n");
            }
            body.push_str(&links(&mut r, &all, 3));
            if i < 600 {
                body.push_str(&format!(" [[{hub}]]"));
            }
            if r.chance(20) {
                body.push_str(&format!("\n\n- [ ] {}\n- [x] {}", sentence(&mut r), sentence(&mut r)));
            }
            write(
                &root.join("Free").join(format!("{t}.md")),
                &format!("---\ntitle: {t}\ndate: {date}\ntype: free\ntags: {}\n---\n\n{body}\n", tags(&mut r)),
                Some(mtime),
            );
        }

        for (i, t) in books.iter().enumerate() {
            let (date, mtime) = some_day(&mut r);
            let status = *r.pick(&["wishlist", "reading", "finished", "finished", "paused"]);
            let mut fm = format!(
                "---\ntitle: {t}\ndate: {date}\ntype: book\ntags: {}\nstatus: {status}\ngenre: {}\nauthor: {} {}\npublisher: {}출판\ncover: _attachments/covers/book{i}.jpg\n",
                tags(&mut r),
                r.pick(GENRES),
                r.pick(PEOPLE),
                r.pick(WORDS),
                r.pick(WORDS)
            );
            if r.chance(80) {
                fm.push_str(&format!("rating: {}\n", 1 + r.below(5)));
            }
            if status == "finished" && r.chance(85) {
                fm.push_str(&format!("finished: {date}\n"));
            }
            let mut body = format!("---\n\n## 소개\n\n{}\n\n## 기록\n", paragraph(&mut r, 6));
            for _ in 0..(3 + r.below(8)) {
                let kind = *r.pick(&["발췌", "생각", "요약", "질문"]);
                body.push_str(&format!("\n> [!{kind}] {date}\n> {}\n", sentence(&mut r)));
            }
            write(&root.join("Books").join(format!("{t}.md")), &(fm + &body), Some(mtime));
            random_file(&root.join(format!("_attachments/covers/book{i}.jpg")), &mut r, 40_000);
        }

        for (i, t) in writing.iter().enumerate() {
            let (date, mtime) = some_day(&mut r);
            let mut body = String::new();
            for _ in 0..(6 + r.below(10)) {
                let n = 6 + r.below(8);
                body.push_str(&paragraph(&mut r, n));
                body.push_str("\n\n");
            }
            body.push_str(&links(&mut r, &all, 2));
            write(
                &root.join("Writing").join(format!("{t}.md")),
                &format!(
                    "---\ntitle: {t}\ndate: {date}\ntype: writing\ntags: {}\nseries: {}\nepisode: {}\nstatus: {}\n---\n\n{body}\n",
                    tags(&mut r),
                    r.pick(SERIES),
                    1 + i % 30,
                    r.pick(&["idea", "draft", "revise", "done"])
                ),
                Some(mtime),
            );
        }

        for t in &meetings {
            let (date, mtime) = some_day(&mut r);
            let people: Vec<&str> = (0..(1 + r.below(4))).map(|_| *r.pick(PEOPLE)).collect();
            let stage = if r.chance(15) { String::new() } else { format!("stage: {}\n", r.pick(&["준비", "진행", "끝"])) };
            write(
                &root.join("회의록").join(format!("{t}.md")),
                &format!(
                    "---\ntitle: {t}\ndate: {date}\ntype: 회의록\ntags: {}\nattendees: [{}]\n{stage}---\n\n## 안건\n\n{}\n\n## 할 일\n\n- [ ] {}\n- [ ] {}\n",
                    tags(&mut r),
                    people.join(", "),
                    paragraph(&mut r, 5),
                    sentence(&mut r),
                    sentence(&mut r)
                ),
                Some(mtime),
            );
        }

        // 일지 3,000일 — 2026-09-30에서 거꾸로
        let last = chrono::NaiveDate::from_ymd_opt(2026, 9, 30).unwrap();
        for d in 0..3000 {
            let day = last - chrono::Duration::days(d);
            let date = day.format("%Y-%m-%d").to_string();
            let mut body = String::from("## 할 일\n\n");
            for _ in 0..(1 + r.below(4)) {
                let mark = if r.chance(60) { "x" } else { " " };
                body.push_str(&format!("- [{mark}] {}\n", sentence(&mut r)));
            }
            body.push_str("\n## 기록\n");
            for _ in 0..(1 + r.below(4)) {
                let kind = *r.pick(&["기록", "느낌", "기록"]);
                let (hour, minute, n) = (7 + r.below(15), r.below(60), 1 + r.below(3));
                body.push_str(&format!(
                    "\n> [!{kind}] {hour:02}:{minute:02}\n> {}\n",
                    paragraph(&mut r, n)
                ));
            }
            if r.chance(25) {
                body.push_str(&format!("\n{}\n", links(&mut r, &all, 2)));
            }
            let mtime = UNIX_EPOCH
                + Duration::from_secs(
                    day.and_hms_opt(21, 0, 0).unwrap().and_utc().timestamp() as u64,
                );
            write(
                &root.join(format!("Daily/{}/{}.md", day.format("%Y/%m"), date)),
                &format!("---\ndate: {date}\ntype: daily\ntags: []\n---\n\n{body}"),
                Some(mtime),
            );
        }
        let notes_done = started.elapsed();

        // 첨부 약 2GB — 진짜 한글 문서(testvault의 hwp) 300부 + 사진처럼 압축 안 되는 파일
        let hwp = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../testvault/_attachments/2026-07")
            .read_dir()
            .ok()
            .and_then(|mut d| d.find_map(|e| e.ok().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "hwp"))));
        if let Some(src) = &hwp {
            for i in 0..300 {
                let dest = root.join(format!("_attachments/2025-{:02}/공고문 {i}.hwp", 1 + i % 12));
                fs::create_dir_all(dest.parent().unwrap()).unwrap();
                fs::copy(src, &dest).unwrap();
            }
        }
        for i in 0..380 {
            let bytes = 2_000_000 + r.below(3_000_000);
            random_file(&root.join(format!("_attachments/2024-{:02}/사진 {i}.jpg", 1 + i % 12)), &mut r, bytes);
        }

        println!(
            "\n합성 vault: {} — 노트 {}편 {:.1}s, 첨부 포함 {:.1}s (hwp 원본 {})",
            root.display(),
            1 + free.len() + books.len() + writing.len() + meetings.len() + 3000,
            notes_done.as_secs_f64(),
            started.elapsed().as_secs_f64(),
            if hwp.is_some() { "있음" } else { "없음 — 사진만" }
        );
    }
}
