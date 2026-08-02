//! 상태 잠금을 쥔 채로 도는 작업들이 실제로 얼마나 걸리는지 재는 자리.
//!
//! 앱은 `Ctx`(vault·indexer·search)를 뮤텍스 하나로 감싸고 모든 커맨드가 그걸 통과한다.
//! 그래서 여기 있는 작업이 오래 걸리면 그동안 저장·검색이 통째로 멈춘다. 어디를 손볼지는
//! 짐작이 아니라 이 수치로 정한다.
//!
//! ```text
//! cargo test -p yamcha-core --release lock_bench -- --ignored --nocapture
//! ```
//! **반드시 `--release`로 잰다** — 디버그 빌드 수치는 자릿수가 다르다.

#[cfg(test)]
mod bench {
    use crate::{Indexer, SearchEngine, Vault};
    use serde_json::json;
    use std::time::Instant;

    /// 실제 사용 규모를 가정한 노트 수
    const NOTES: usize = 2_000;
    /// 노트 한 편의 대략적인 분량 (한글 기준)
    const CHARS: usize = 1_200;

    fn body_of(i: usize) -> String {
        let seed = [
            "책을 읽다가 접어 둔 문장을 옮겨 적었다",
            "이 대목은 다시 읽어야 한다 #독서",
            "저자가 말하는 핵심은 결국 태도의 문제다",
            "오늘 쓴 것: 서두를 고쳐 썼다 #글쓰기",
            "[[다른 노트]]와 이어지는 이야기",
        ];
        let mut s = String::with_capacity(CHARS * 3);
        let mut n = 0;
        while n < CHARS {
            let line = seed[(i + n) % seed.len()];
            s.push_str(line);
            s.push('\n');
            n += line.chars().count();
        }
        s
    }

    /// 노트 NOTES편이 든 vault를 만든다 (색인 전)
    fn build_vault() -> (tempfile::TempDir, Vault, u128) {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        let t = Instant::now();
        for i in 0..NOTES {
            let rel = v
                .create_note("free", &format!("노트 {i}"), json!({ "tags": ["독서"] }))
                .unwrap();
            v.save_note(&rel, json!({ "tags": ["독서"] }), &body_of(i))
                .unwrap();
        }
        (dir, v, t.elapsed().as_millis())
    }

    #[test]
    #[ignore]
    fn lock_bench() {
        let (dir, mut v, write_ms) = build_vault();
        println!("\n=== 잠금을 쥐고 도는 작업 실측 ({NOTES}편, 편당 약 {CHARS}자) ===");
        println!("(준비) 노트 쓰기: {write_ms}ms");

        let index_dir = dir.path().join("_bench_index");
        let mut indexer = Indexer::open(&index_dir.join("index.db")).unwrap();
        let mut search = SearchEngine::open(&index_dir.join("search")).unwrap();

        // ① 첫 실행 — 색인이 비어 있으니 전부 읽는다
        let t = Instant::now();
        let n = crate::reindex_changed(&v, &mut indexer, &mut search).unwrap();
        println!(
            "① 첫 실행 (전체 색인): {}ms, {}편",
            t.elapsed().as_millis(),
            n.indexed
        );

        // ①-b 두 번째 실행 — 바뀐 게 없다. 앱을 켤 때마다 치르는 실제 값.
        let t = Instant::now();
        let n = crate::reindex_changed(&v, &mut indexer, &mut search).unwrap();
        println!(
            "①-b 두 번째 실행 (증분): {}ms, 다시읽음 {}편 / 건너뜀 {}편",
            t.elapsed().as_millis(),
            n.indexed,
            n.skipped
        );

        // ①-c 한 편만 고치고 다시 켠 상황.
        // (경로는 list_note_files로 얻는다 — list_notes를 부르면 요약 캐시가 데워져서
        //  바로 아래 ②의 "첫 호출"이 첫 호출이 아니게 된다)
        let one = v.list_note_files().unwrap()[0].rel_path.clone();
        std::thread::sleep(std::time::Duration::from_millis(15));
        v.save_note(&one, json!({}), "한 편만 고쳤다").unwrap();
        let t = Instant::now();
        let n = crate::reindex_changed(&v, &mut indexer, &mut search).unwrap();
        println!(
            "①-c 한 편 고치고 재실행: {}ms, 다시읽음 {}편",
            t.elapsed().as_millis(),
            n.indexed
        );

        // ② 노트 목록 — 첫 호출 (캐시가 비어 있다)
        let t = Instant::now();
        let notes = v.list_notes().unwrap();
        println!("② list_notes 첫 호출: {}ms, {}편", t.elapsed().as_millis(), notes.len());

        // ②-b 저장 뒤 화면 갱신 — 자동저장마다 치르는 실제 값
        let one = notes[0].rel_path.clone();
        v.save_note(&one, json!({}), "한 편만 고쳤다 2").unwrap();
        let t = Instant::now();
        let again = v.list_notes().unwrap();
        println!(
            "②-b 저장 뒤 갱신 (한 편만 바뀜): {}ms, {}편",
            t.elapsed().as_millis(),
            again.len()
        );

        // ②-c 갱신 비용의 바닥 — 파일 훑기(stat)만. 나머지는 요약 복제 값이다.
        let t = Instant::now();
        let files = v.list_note_files().unwrap();
        println!(
            "②-c list_note_files만 (stat): {}ms, {}개",
            t.elapsed().as_millis(),
            files.len()
        );

        // ③ 점검 (감사 화면)
        let t = Instant::now();
        let issues = crate::audit::audit(&v).len();
        println!("③ audit::scan: {}ms, {issues}건", t.elapsed().as_millis());

        // ④ 태그 이름 바꾸기 (전 노트를 고쳐 쓴다)
        let t = Instant::now();
        let changed = v.rename_tag("독서", "읽기").unwrap().len();
        println!("④ rename_tag (전 노트 재작성): {}ms, {changed}편", t.elapsed().as_millis());

        // ⑤ 노트 한 편 저장 — 자동저장이 3초마다 치르는 값. 여기가 제일 중요하다.
        let rel = notes[0].rel_path.clone();
        let t = Instant::now();
        for i in 0..20 {
            v.save_note(&rel, json!({}), &format!("{i}번째로 고친다")).unwrap();
        }
        println!(
            "⑤ save_note 20회 (자동저장): 총 {}ms, 회당 {}µs",
            t.elapsed().as_millis(),
            t.elapsed().as_micros() / 20
        );

        // ⑥ 밀린 목록 파일 만들기 (손을 멈췄을 때 한 번)
        let t = Instant::now();
        let n = v.flush_index_files().unwrap();
        println!("⑥ flush_index_files: {}ms, {n}종류", t.elapsed().as_millis());

        v.set_history_policy(crate::HistoryPolicy::default());
        println!("===\n");
    }
}
