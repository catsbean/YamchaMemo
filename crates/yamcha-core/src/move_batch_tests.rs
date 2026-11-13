//! `Vault::move_notes_with` — 노트 여러 편을 한 번에 옮기기.

use serde_json::json;

use crate::Vault;

fn vault() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    (dir, v)
}

fn body_of(v: &Vault, rel: &str) -> String {
    v.read_note(rel).unwrap().body.trim().to_string()
}

fn set_body(v: &Vault, rel: &str, body: &str) {
    let n = v.read_note(rel).unwrap();
    v.save_note(rel, n.frontmatter, body).unwrap();
}

#[test]
fn 여러_편을_한_번에_옮긴다() {
    let (_d, v) = vault();
    let rels: Vec<String> = ["하나", "둘", "셋"]
        .iter()
        .map(|t| v.create_note("free", t, json!({})).unwrap())
        .collect();
    let r = v.move_notes_with(&rels, "writing", &mut |_, _| {}).unwrap();
    assert!(r.skipped.is_empty(), "{:?}", r.skipped);
    assert_eq!(
        r.moved,
        vec![
            ("Free/하나.md".to_string(), "Writing/하나.md".to_string()),
            ("Free/둘.md".to_string(), "Writing/둘.md".to_string()),
            ("Free/셋.md".to_string(), "Writing/셋.md".to_string()),
        ]
    );
    for (from, to) in &r.moved {
        assert!(v.read_note(from).is_err(), "옛 자리에 남았다: {from}");
        assert_eq!(v.read_note(to).unwrap().note_type, "writing");
    }
    assert!(v.list_notes_of_type("free").unwrap().is_empty());
}

/// 편수만큼 vault를 훑지 않는다 — 링크 고치기는 한 번이다.
#[test]
fn 링크는_한_번만_훑어_고친다() {
    let (_d, v) = vault();
    let a = v.create_note("free", "가", json!({})).unwrap();
    let b = v.create_note("free", "나", json!({})).unwrap();
    let c = v.create_note("free", "다", json!({})).unwrap();
    let watcher = v.create_note("writing", "지켜보는 글", json!({})).unwrap();
    set_body(&v, &watcher, "[[Free/가]] [[Free/나|이름]] [[Free/다#절]] [[가]]");

    // 한 번 훑으면 진행 알림의 '끝'(done == total)이 한 번만 온다
    let mut passes = 0;
    let r = v
        .move_notes_with(&[a, b, c], "writing", &mut |done, total| {
            if done == total {
                passes += 1;
            }
        })
        .unwrap();
    assert_eq!(passes, 1, "vault를 {passes}번 훑었다");
    assert_eq!(r.rewritten, vec![watcher.clone()]);
    assert_eq!(
        body_of(&v, &watcher),
        "[[Writing/가]] [[Writing/나|이름]] [[Writing/다#절]] [[가]]"
    );
}

/// 함께 옮기는 글끼리 경로로 가리키고 있어도 따라온다.
#[test]
fn 함께_옮긴_글끼리의_경로_링크도_따라온다() {
    let (_d, v) = vault();
    let a = v.create_note("free", "가", json!({})).unwrap();
    let b = v.create_note("free", "나", json!({})).unwrap();
    set_body(&v, &a, "[[Free/나]]");
    let r = v.move_notes_with(&[a, b], "writing", &mut |_, _| {}).unwrap();
    assert_eq!(body_of(&v, "Writing/가.md"), "[[Writing/나]]");
    // 옮긴 글 자신은 '링크를 고쳐 쓴 다른 노트'에 들지 않는다
    assert!(r.rewritten.is_empty(), "{:?}", r.rewritten);
}

#[test]
fn 못_옮기는_것이_섞여도_나머지는_옮긴다() {
    let (_d, v) = vault();
    let ok1 = v.create_note("free", "하나", json!({})).unwrap();
    let book = v.create_note("book", "어떤 책", json!({})).unwrap();
    let already = v.create_note("writing", "이미 글쓰기", json!({})).unwrap();
    let ok2 = v.create_note("free", "둘", json!({})).unwrap();
    let rels = vec![
        ok1,
        book.clone(),
        "Free/없는 글.md".to_string(),
        already.clone(),
        ok2,
    ];
    let r = v.move_notes_with(&rels, "writing", &mut |_, _| {}).unwrap();
    assert_eq!(r.moved.len(), 2);
    let skipped: Vec<&str> = r.skipped.iter().map(|(rel, _)| rel.as_str()).collect();
    assert_eq!(skipped, vec![book.as_str(), "Free/없는 글.md", already.as_str()]);
    // 못 옮긴 것은 제자리에 그대로
    assert_eq!(v.read_note(&book).unwrap().note_type, "book");
    assert_eq!(v.read_note(&already).unwrap().note_type, "writing");
}

#[test]
fn 같은_이름이_있으면_번호가_붙는다() {
    let (_d, v) = vault();
    v.create_note("writing", "메모", json!({})).unwrap();
    let a = v.create_note("free", "메모", json!({})).unwrap();
    let r = v.move_notes_with(&[a], "writing", &mut |_, _| {}).unwrap();
    assert_eq!(r.moved[0].1, "Writing/메모 (2).md");
}

#[test]
fn 같은_글을_두_번_넘겨도_한_번만_옮긴다() {
    let (_d, v) = vault();
    let a = v.create_note("free", "하나", json!({})).unwrap();
    let r = v.move_notes_with(&[a.clone(), a], "writing", &mut |_, _| {}).unwrap();
    assert_eq!(r.moved.len(), 1);
    assert!(r.skipped.is_empty());
}

#[test]
fn 책_일지로는_통째로_거절한다() {
    let (_d, v) = vault();
    let a = v.create_note("free", "하나", json!({})).unwrap();
    assert!(v.move_notes_with(std::slice::from_ref(&a), "book", &mut |_, _| {}).is_err());
    assert!(v.move_notes_with(std::slice::from_ref(&a), "daily", &mut |_, _| {}).is_err());
    assert!(v.move_notes_with(std::slice::from_ref(&a), "없는분류", &mut |_, _| {}).is_err());
    assert_eq!(v.read_note(&a).unwrap().note_type, "free");
}

/// 되돌리기 — 옮긴 것을 도로 옮기면 경로도 링크도 처음과 같다.
#[test]
fn 도로_옮기면_처음과_같다() {
    let (_d, v) = vault();
    let a = v.create_note("free", "가", json!({})).unwrap();
    let b = v.create_note("free", "나", json!({})).unwrap();
    let watcher = v.create_note("writing", "지켜보는 글", json!({})).unwrap();
    set_body(&v, &watcher, "[[Free/가]] 와 [[Free/나]]");

    let there = v.move_notes_with(&[a.clone(), b.clone()], "writing", &mut |_, _| {}).unwrap();
    let back: Vec<String> = there.moved.iter().map(|(_, to)| to.clone()).collect();
    let r = v.move_notes_with(&back, "free", &mut |_, _| {}).unwrap();
    let now: Vec<&str> = r.moved.iter().map(|(_, to)| to.as_str()).collect();
    assert_eq!(now, vec![a.as_str(), b.as_str()]);
    assert_eq!(body_of(&v, &watcher), "[[Free/가]] 와 [[Free/나]]");
}

// ── 여러 편 휴지통으로 · 태그 붙이기 (9-6) ──

#[test]
fn 여러_편을_휴지통으로_보내고_되살린다() {
    let (_d, v) = vault();
    let a = v.create_note("free", "가", json!({})).unwrap();
    let b = v.create_note("writing", "나", json!({})).unwrap();
    let r = v.trash_notes(&[a.clone(), "Free/없는 글.md".into(), b.clone(), a.clone()]);
    assert_eq!(r.done.len(), 2, "{:?}", r);
    assert_eq!(r.skipped.len(), 1);
    assert_eq!(r.skipped[0].0, "Free/없는 글.md");
    assert!(v.read_note(&a).is_err());
    // 돌려준 휴지통 파일 이름으로 그대로 되살아난다 — 제자리로
    for (rel, file) in &r.done {
        assert_eq!(&v.restore_trash(file).unwrap().rel, rel);
    }
    assert_eq!(v.list_notes().unwrap().len(), 2);
}

#[test]
fn 같은_이름을_같은_초에_지워도_휴지통에서_겹치지_않는다() {
    let (_d, v) = vault();
    let a = v.create_note("free", "같은 이름", json!({})).unwrap();
    let b = v.create_note("writing", "같은 이름", json!({})).unwrap();
    let r = v.trash_notes(&[a.clone(), b.clone()]);
    assert_eq!(r.done.len(), 2);
    assert_ne!(r.done[0].1, r.done[1].1, "휴지통 파일 이름이 겹쳤다");
    let back: Vec<String> = r.done.iter().map(|(_, f)| v.restore_trash(f).unwrap().rel).collect();
    assert_eq!(back, vec![a, b]);
}

#[test]
fn 여러_편에_태그를_붙인다() {
    let (_d, v) = vault();
    let a = v.create_note("free", "가", json!({})).unwrap();
    let b = v.create_note("free", "나", json!({ "tags": ["기존"] })).unwrap();
    let c = v.create_note("free", "다", json!({ "tags": ["모임"] })).unwrap();
    let d = v.create_note("free", "라", json!({})).unwrap();
    set_body(&v, &d, "본문에 #모임 이라고 적었다");

    let r = v
        .add_tag_to_notes(&[a.clone(), b.clone(), c.clone(), d.clone(), "Free/없음.md".into()], "#모임")
        .unwrap();
    assert_eq!(r.changed, vec![a.clone(), b.clone()]);
    assert_eq!(r.already, vec![c.clone(), d.clone()]);
    assert_eq!(r.skipped.len(), 1);

    let tags = |rel: &str| v.read_note(rel).unwrap().frontmatter["tags"].clone();
    assert_eq!(tags(&a), json!(["모임"]));
    assert_eq!(tags(&b), json!(["기존", "모임"]));
    // 본문은 그대로
    assert_eq!(body_of(&v, &d), "본문에 #모임 이라고 적었다");
}

#[test]
fn 태그에_못_쓰는_글자는_거절한다() {
    let (_d, v) = vault();
    let a = v.create_note("free", "가", json!({})).unwrap();
    for bad in ["", "#", "두 낱말", "a#b", "쉼표,"] {
        assert!(v.add_tag_to_notes(std::slice::from_ref(&a), bad).is_err(), "{bad}");
    }
    assert!(v.read_note(&a).unwrap().frontmatter.get("tags").is_none_or(|t| t == &json!([])));
}
