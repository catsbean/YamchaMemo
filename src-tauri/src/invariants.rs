//! 불변식 시험 — 무작위 조작 뒤에도 **디스크·목록·색인·검색이 한 몸인가**.
//!
//! 이 앱의 사고는 대부분 "한 군데를 빠뜨려서"였다. 노트인가 판단이 다섯 군데에 복사돼
//! 있었고, 저장 뒤 색인 갱신은 부르는 쪽이 기억해야 했고, 원자적 쓰기는 골라 써야 했다.
//! 하나씩 짚는 시험은 이미 알려진 구멍만 막는다. 여기서는 만들기·저장·제목 바꾸기·옮기기·
//! 지우기·복구·바깥 편집·목록 파일 갱신을 무작위로 섞어 돌리고, 매 단계 아래를 확인한다.
//!
//! 1. 사용자가 만든(또는 남이 넣은) 노트 = 목록 — 만든 글이 앱에서 사라지지 않는다
//! 2. 디스크의 `.md` = 목록 — 노트 판정(`is_note_file`)을 **쓰지 않고** 센다. 잣대가 틀려도 잡힌다
//! 3. 색인 = 목록, 검색 = 목록
//! 4. 색인이 기억하는 파일 신원(수정시각·크기) = 디스크 — 앱이 쓰고 색인을 안 고치면 걸린다
//! 5. 휴지통 항목 수 = 지운 수 − 되살린 수 — 지운 글이 휴지통에서 덮이지 않는다
//!
//! 끝에서는 처음부터 다시 만든 색인과 태그·백링크를 견준다 (증분으로 고친 색인이 낡지 않았나).
//!
//! 조작은 앱과 **같은 길**을 탄다 — 커맨드의 몸통(`*_in`)과 감시의 색인 처리(`apply_md_changes`)를
//! 그대로 부른다. 실패하면 proptest가 가장 짧은 조작 순서로 줄여서 보여 준다.
//! 더 깊게 돌리려면 `PROPTEST_CASES=1000 cargo test -p yamcha-app invariants`.

// 다른 편집기·다른 기기의 쓰기를 흉내 내려고 맨 쓰기를 쓴다 (앱의 쓰기는 모두 원자적이다)
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeSet;
use std::path::Path;

use proptest::prelude::*;
use yamcha_core::{Indexer, SearchEngine, Vault};

use crate::commands::maintenance::restore_trash_in;
use crate::commands::notes::{
    create_note_in, delete_note_in, move_note_in, rename_note_in, save_note_in,
};
use crate::commands::{dashboard, Ctx};
use crate::watcher::apply_md_changes;

const TYPES: &[&str] = &["free", "writing", "book", "daily"];

/// 사고가 났던 이름들을 일부러 섞는다 — 앞의 `_`, 금지 문자, 끝의 마침표, 빈 제목, 겹치는 제목.
const TITLES: &[&str] = &[
    "메모", "메모", "_초안", "__", "a/b:c", "이름...", "  ", "[[메모]]", "#태그 제목", "책", "무제",
];

/// 서로를 가리키는 링크와 태그를 섞는다 — 백링크·태그 색인이 낡으면 끝의 대조에서 걸린다.
const BODIES: &[&str] = &[
    "",
    "그냥 본문",
    "[[메모]]로 이어진다 #연결",
    "[[책]] 읽고 [[초안]] 고침 #독서",
    "- [ ] 할 일 [[없는 노트]]",
    "#태그/하위 [[a b c]] [[이름]]",
];

#[derive(Debug, Clone)]
enum Op {
    Create { ty: usize, title: usize },
    Save { note: usize, body: usize },
    Rename { note: usize, title: usize },
    Move { note: usize, ty: usize },
    Delete { note: usize },
    /// 가장 최근에 지운 것을 휴지통에서 되살린다
    Restore,
    /// 다른 편집기가 본문을 고쳤다 (frontmatter는 그대로)
    ExternalEdit { note: usize, body: usize },
    /// 다른 편집기·탐색기가 지웠다 (휴지통을 거치지 않는다)
    ExternalDelete { note: usize },
    /// 다른 기기에서 동기화로 새 노트가 들어왔다
    ExternalCreate { ty: usize, title: usize },
    /// 손을 멈춰 `_index.md`가 다시 만들어졌고, 감시가 그걸 봤다
    FlushIndex,
}

fn op() -> impl Strategy<Value = Op> {
    let ty = 0..TYPES.len();
    let title = 0..TITLES.len();
    let body = 0..BODIES.len();
    let note = 0..64usize;
    prop_oneof![
        3 => (ty.clone(), title.clone()).prop_map(|(ty, title)| Op::Create { ty, title }),
        3 => (note.clone(), body.clone()).prop_map(|(note, body)| Op::Save { note, body }),
        2 => (note.clone(), title.clone()).prop_map(|(note, title)| Op::Rename { note, title }),
        1 => (note.clone(), ty.clone()).prop_map(|(note, ty)| Op::Move { note, ty }),
        2 => note.clone().prop_map(|note| Op::Delete { note }),
        1 => Just(Op::Restore),
        2 => (note.clone(), body.clone()).prop_map(|(note, body)| Op::ExternalEdit { note, body }),
        1 => note.clone().prop_map(|note| Op::ExternalDelete { note }),
        1 => (ty.clone(), title.clone()).prop_map(|(ty, title)| Op::ExternalCreate { ty, title }),
        1 => Just(Op::FlushIndex),
    ]
}

fn ctx(vault_root: &Path, index_root: &Path) -> Ctx {
    Ctx {
        vault: Vault::open(vault_root).unwrap(),
        indexer: Indexer::open(&index_root.join("index.db")).unwrap(),
        search: SearchEngine::open(&index_root.join("search")).unwrap(),
        todo_cache: dashboard::TodoCache::default(),
    }
}

/// 사용자가 있다고 믿는 것 — 앱이 돌려준 결과만으로 쌓는다.
#[derive(Debug, Default)]
struct Model {
    /// 노트 경로
    notes: BTreeSet<String>,
    /// 휴지통에 있어야 할 항목 수 (지운 수 − 되살린 수)
    trash: usize,
}

fn pick(model: &BTreeSet<String>, n: usize) -> Option<String> {
    if model.is_empty() {
        return None;
    }
    model.iter().nth(n % model.len()).cloned()
}

/// frontmatter는 두고 본문만 갈아 끼운다 — 다른 편집기가 본문만 고친 것처럼.
fn replace_body(raw: &str, body: &str) -> String {
    if let Some(rest) = raw.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let header = &raw[..3 + end + 4];
            return format!("{header}\n\n{body}\n");
        }
    }
    format!("{body}\n")
}

/// 조작 하나를 앱과 같은 길로 흘려보내고, 모델(사용자가 있다고 믿는 노트)을 고친다.
/// 앱이 거절한 조작(빈 제목 등)은 모델을 건드리지 않는다 — 거절했으면 아무것도 바뀌지 않아야 한다.
fn apply(c: &mut Ctx, model: &mut Model, op: &Op) {
    let root = c.vault.root().to_path_buf();
    match *op {
        Op::Create { ty, title } => {
            if let Ok(rel) = create_note_in(c, TYPES[ty], TITLES[title], serde_json::Value::Null) {
                model.notes.insert(rel);
            }
        }
        Op::Save { note, body } => {
            let Some(rel) = pick(&model.notes, note) else { return };
            let Ok(cur) = c.vault.read_note(&rel) else { return };
            let _ = save_note_in(c, &rel, cur.frontmatter, BODIES[body], None);
        }
        Op::Rename { note, title } => {
            let Some(rel) = pick(&model.notes, note) else { return };
            if let Ok(new_rel) = rename_note_in(c, &rel, TITLES[title]) {
                model.notes.remove(&rel);
                model.notes.insert(new_rel);
            }
        }
        Op::Move { note, ty } => {
            let Some(rel) = pick(&model.notes, note) else { return };
            if let Ok(new_rel) = move_note_in(c, &rel, TYPES[ty]) {
                model.notes.remove(&rel);
                model.notes.insert(new_rel);
            }
        }
        Op::Delete { note } => {
            let Some(rel) = pick(&model.notes, note) else { return };
            if delete_note_in(c, &rel).is_ok() {
                model.notes.remove(&rel);
                model.trash += 1;
            }
        }
        Op::Restore => {
            let Ok(trash) = c.vault.list_trash() else { return };
            let Some(latest) = trash.first() else { return };
            if let Ok(rel) = restore_trash_in(c, &latest.file_name) {
                model.notes.insert(rel);
                model.trash -= 1;
            }
        }
        Op::ExternalEdit { note, body } => {
            let Some(rel) = pick(&model.notes, note) else { return };
            let abs = root.join(&rel);
            let Ok(raw) = std::fs::read_to_string(&abs) else { return };
            std::fs::write(&abs, replace_body(&raw, BODIES[body])).unwrap();
            apply_md_changes(c, &[rel]);
        }
        Op::ExternalDelete { note } => {
            let Some(rel) = pick(&model.notes, note) else { return };
            std::fs::remove_file(root.join(&rel)).unwrap();
            model.notes.remove(&rel);
            apply_md_changes(c, &[rel]);
        }
        Op::ExternalCreate { ty, title } => {
            // 데일리는 날짜가 곧 이름이라 다른 기기에서 "새 제목"으로 들어올 일이 없다
            if TYPES[ty] == "daily" {
                return;
            }
            let Some(def) = c.vault.def_by_id(TYPES[ty]) else { return };
            // 다른 기기도 같은 앱이다 — 같은 규칙으로 파일명을 만든다
            let rel = format!("{}/{}.md", def.folder, Vault::sanitize_note_stem(TITLES[title]));
            let abs = root.join(&rel);
            if abs.exists() {
                return; // 동기화는 남의 파일을 덮지 않고 충돌 사본을 만든다 — 여기선 건너뛴다
            }
            let content = format!("---\ntype: {}\ndate: 2026-09-26\n---\n\n바깥에서 왔다\n", TYPES[ty]);
            std::fs::write(&abs, content).unwrap();
            model.notes.insert(rel.clone());
            apply_md_changes(c, &[rel]);
        }
        Op::FlushIndex => {
            let _ = c.vault.flush_index_files();
            let lists: Vec<String> = c
                .vault
                .types()
                .iter()
                .map(|t| format!("{}/_index.md", t.folder))
                .filter(|rel| root.join(rel).is_file())
                .collect();
            apply_md_changes(c, &lists);
        }
    }
}

/// 디스크에 있는 노트 파일 — `is_note_file`을 **일부러 쓰지 않는다**. 그 잣대가 틀려도
/// (예: 사용자가 만든 `_초안.md`를 노트가 아니라고 보면) 여기서 드러나야 한다.
/// 앱이 만드는 목록 파일 이름 하나만 뺀다.
fn disk_notes(vault: &Vault) -> BTreeSet<String> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeSet<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                walk(root, &path, out);
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(".md") && name != "_index.md" {
                let rel = path.strip_prefix(root).unwrap();
                out.insert(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut out = BTreeSet::new();
    for t in vault.types() {
        walk(vault.root(), &vault.root().join(&t.folder), &mut out);
    }
    out
}

/// 두 집합이 같은가. 다르면 어느 쪽에만 있는지 적어 돌려준다.
fn same(what: &str, left: &str, a: &BTreeSet<String>, right: &str, b: &BTreeSet<String>) -> Result<(), String> {
    if a == b {
        return Ok(());
    }
    let only_a: Vec<_> = a.difference(b).collect();
    let only_b: Vec<_> = b.difference(a).collect();
    Err(format!("{what}: {left}에만 {only_a:?}, {right}에만 {only_b:?}"))
}

fn check(c: &Ctx, model: &Model) -> Result<(), String> {
    let e = |e: yamcha_core::CoreError| e.to_string();
    let listed: BTreeSet<String> = c.vault.list_notes().map_err(e)?.into_iter().map(|n| n.rel_path).collect();

    same("만든 노트가 앱에서 사라졌거나 없는 노트가 생겼다", "모델", &model.notes, "목록", &listed)?;
    same("디스크와 목록이 다르다", "디스크", &disk_notes(&c.vault), "목록", &listed)?;

    let in_trash = c.vault.list_trash().map_err(e)?.len();
    if in_trash != model.trash {
        return Err(format!(
            "휴지통에 {}개가 있어야 하는데 {in_trash}개다 — 지운 글이 덮였거나 사라졌다",
            model.trash
        ));
    }

    let states = c.indexer.note_states().map_err(e)?;
    let indexed: BTreeSet<String> = states.keys().cloned().collect();
    same("색인과 목록이 다르다", "색인", &indexed, "목록", &listed)?;

    let searched: BTreeSet<String> = c.search.note_paths().map_err(e)?.into_iter().collect();
    same("검색과 목록이 다르다", "검색", &searched, "목록", &listed)?;

    for f in c.vault.list_note_files().map_err(e)? {
        let on_disk = (f.mtime, f.size);
        if states.get(&f.rel_path) != Some(&on_disk) {
            return Err(format!(
                "색인의 신원이 디스크와 다르다 — 앱이 파일을 쓰고 색인을 안 고쳤다: {} 색인 {:?} 디스크 {:?}",
                f.rel_path,
                states.get(&f.rel_path),
                on_disk
            ));
        }
    }
    Ok(())
}

/// 증분으로 고쳐 온 색인 = 처음부터 다시 만든 색인 (태그·백링크).
fn check_against_rebuild(c: &Ctx) -> Result<(), String> {
    let e = |e: yamcha_core::CoreError| e.to_string();
    let dir = tempfile::tempdir().unwrap();
    let mut fresh = Indexer::open(&dir.path().join("index.db")).map_err(e)?;
    let mut fresh_search = SearchEngine::open(&dir.path().join("search")).map_err(e)?;
    yamcha_core::reindex_all(&c.vault, &mut fresh, &mut fresh_search).map_err(e)?;

    let tags = |i: &Indexer| -> Result<BTreeSet<String>, String> {
        Ok(i.all_tags().map_err(e)?.into_iter().map(|t| format!("{}×{}", t.tag, t.count)).collect())
    };
    same("태그", "증분", &tags(&c.indexer)?, "재구성", &tags(&fresh)?)?;

    for n in c.vault.list_notes().map_err(e)? {
        let links = |i: &Indexer| -> Result<BTreeSet<String>, String> {
            Ok(i
                .backlinks(&c.vault, &n.rel_path)
                .map_err(e)?
                .into_iter()
                .map(|r| format!("{} ({}, {})", r.rel_path, r.title, r.date))
                .collect())
        };
        same(&format!("{}의 백링크", n.rel_path), "증분", &links(&c.indexer)?, "재구성", &links(&fresh)?)?;
    }
    Ok(())
}

fn run(ops: &[Op]) -> Result<(), TestCaseError> {
    let vault_dir = tempfile::tempdir().unwrap();
    let index_dir = tempfile::tempdir().unwrap();
    let mut c = ctx(vault_dir.path(), index_dir.path());
    let mut model = Model::default();
    for (i, op) in ops.iter().enumerate() {
        apply(&mut c, &mut model, op);
        check(&c, &model).map_err(|m| TestCaseError::fail(format!("{}번째 조작 {op:?} 뒤: {m}", i + 1)))?;
    }
    check_against_rebuild(&c).map_err(|m| TestCaseError::fail(format!("조작을 모두 마친 뒤: {m}")))?;
    Ok(())
}

fn config() -> ProptestConfig {
    let cases = std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(48);
    ProptestConfig { cases, ..ProptestConfig::default() }
}

proptest! {
    #![proptest_config(config())]

    #[test]
    fn 무작위_조작_뒤에도_디스크_목록_색인_검색이_한_몸이다(ops in prop::collection::vec(op(), 1..30)) {
        run(&ops)?;
    }
}

/// 시험이 헛돌지 않는지 — 흔한 조작이 실제로 성공하고 불변식이 그 위에서 확인되는가.
/// (조작이 늘 거절되면 무작위 시험은 빈 vault만 들여다보고 통과한다.)
#[test]
fn 흔한_조작은_성공하고_불변식이_선다() {
    let vault_dir = tempfile::tempdir().unwrap();
    let index_dir = tempfile::tempdir().unwrap();
    let mut c = ctx(vault_dir.path(), index_dir.path());
    let mut model = Model::default();
    let ops = [
        Op::Create { ty: 0, title: 0 },   // 자유노트 "메모"
        Op::Create { ty: 2, title: 9 },   // 책 "책"
        Op::Save { note: 0, body: 3 },    // 책·초안을 가리키는 본문
        Op::Rename { note: 1, title: 2 }, // "_초안"으로 — 앞의 `_`가 떨어져야 한다
        Op::ExternalEdit { note: 0, body: 2 },
        Op::FlushIndex,
        Op::Delete { note: 0 },
        Op::Restore,
    ];
    for (i, op) in ops.iter().enumerate() {
        apply(&mut c, &mut model, op);
        check(&c, &model).unwrap_or_else(|m| panic!("{}번째 조작 {op:?} 뒤: {m}", i + 1));
    }
    assert_eq!(model.notes.len(), 2, "흔한 조작이 거절됐다: {model:?}");
    check_against_rebuild(&c).unwrap();
}
