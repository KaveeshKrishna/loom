//! The engine against a real Loom (tests/stack in the repo). Skipped unless
//! LOOM_TEST_URL is set, e.g.:
//!
//!   tests/stack/stack.sh up
//!   LOOM_TEST_URL=http://localhost:18085 LOOM_TEST_DIR=~/.cache/loomtest cargo test -p loom-engine --test live
//!
//! The test stack uses 1 MiB chunks; the engine is set to 1 MiB too, so
//! small files still exercise multi-chunk, parallel and resume paths.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use loom_engine::store::Store;
use loom_engine::*;
use rand::RngCore;
use sha2::Digest;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};

const MIB: usize = 1 << 20;

fn base() -> Option<String> {
    std::env::var("LOOM_TEST_URL").ok().filter(|s| !s.is_empty())
}

macro_rules! need_server {
    () => {
        match base() {
            Some(b) => b,
            None => {
                eprintln!("LOOM_TEST_URL not set: skipping");
                return;
            }
        }
    };
}

fn media() -> PathBuf {
    let dir = std::env::var("LOOM_TEST_DIR").unwrap_or_else(|_| format!("{}/.cache/loomtest", std::env::var("HOME").unwrap_or_default()));
    PathBuf::from(dir).join("media")
}

fn sha(b: &[u8]) -> String {
    hex::encode(sha2::Sha256::digest(b))
}

fn random(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut v);
    v
}

fn uniq(p: &str) -> String {
    format!("{p}-{:08x}", rand::random::<u32>())
}

// ─── accounts ────────────────────────────────────────────────────────────────

const OWNER_EMAIL: &str = "owner@loom.test";
const OWNER_PASSWORD: &str = "owner-password-123";

async fn owner_cookie(base: &str) -> String {
    let c = reqwest::Client::new();
    let setup: serde_json::Value = c.get(format!("{base}/api/setup")).send().await.unwrap().json().await.unwrap();
    if setup["needsSetup"] == true {
        c.post(format!("{base}/api/setup"))
            .json(&serde_json::json!({ "name": "Test Owner", "email": OWNER_EMAIL, "password": OWNER_PASSWORD }))
            .send()
            .await
            .unwrap();
    }
    let res = c
        .post(format!("{base}/api/auth/sign-in/email"))
        .header("origin", base)
        .header("x-forwarded-for", format!("10.77.{}.{}", rand::random::<u8>(), rand::random::<u8>() | 1))
        .json(&serde_json::json!({ "email": OWNER_EMAIL, "password": OWNER_PASSWORD }))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "sign-in: {}", res.status());
    res.headers().get_all("set-cookie").iter().filter_map(|v| v.to_str().ok()).map(|v| v.split(';').next().unwrap().to_string()).collect::<Vec<_>>().join("; ")
}

/// One paired device shared by the tests (pairing is rate-limited on the
/// server, as it should be); a test that removes its device pairs its own.
async fn pair(base: &str) -> (String, String, String) {
    static SHARED: tokio::sync::OnceCell<(String, String, String)> = tokio::sync::OnceCell::const_new();
    SHARED.get_or_init(|| pair_new(base)).await.clone()
}

/// Pair a device the way the apps do (token made here, only its hash sent).
async fn pair_new(base: &str) -> (String, String, String) {
    let cookie = owner_cookie(base).await;
    let c = reqwest::Client::new();
    let code: serde_json::Value = c.post(format!("{base}/api/devices/codes")).header("cookie", &cookie).send().await.unwrap().json().await.unwrap();
    let token = format!("loomd_{}", hex::encode(random(32)));
    let r: serde_json::Value = c
        .post(format!("{base}/api/devices/pair/redeem"))
        .header("x-forwarded-for", format!("10.78.{}.{}", rand::random::<u8>(), rand::random::<u8>() | 1))
        .json(&serde_json::json!({ "code": code["code"], "name": uniq("Engine test"), "platform": "windows", "tokenHash": sha(token.as_bytes()) }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    (token, r["device"]["id"].as_str().unwrap().to_string(), cookie)
}

fn settings() -> Settings {
    Settings { parallel_files: 3, parallel_chunks: 3, speed_limit: 0, chunk_internet: MIB as u64, chunk_lan: MIB as u64, use_lan: true }
}

async fn engine_at(base: &str, token: &str, db: &Path, s: Settings) -> Engine {
    Engine::start(
        db.to_path_buf(),
        ServerConfig { public_url: base.to_string(), token: token.to_string(), instance_id: None, lan: None },
        s,
        "loom-engine-tests",
    )
    .unwrap()
}

async fn mkdir(base: &str, cookie: &str, name: &str) {
    reqwest::Client::new()
        .post(format!("{base}/api/fs/mkdir"))
        .header("cookie", cookie)
        .json(&serde_json::json!({ "parentPath": "", "name": name }))
        .send()
        .await
        .unwrap();
}

async fn wait_batch(e: &Engine, id: BatchId, secs: u64) -> BatchView {
    let until = Instant::now() + Duration::from_secs(secs);
    loop {
        let b = e.batches(true).unwrap().into_iter().find(|b| b.id == id).expect("batch");
        if b.state == "done" || b.state == "cancelled" {
            return b;
        }
        if Instant::now() > until {
            let items = e.items(id, 0, 50).unwrap();
            panic!("batch {id} not done in {secs}s: {b:?}\n{items:#?}");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn wait_for(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(secs);
    while !f() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn file_src(p: &Path) -> UploadSource {
    UploadSource { path: p.to_path_buf(), conflict: None, relative_path: None }
}

// ─── a TCP proxy that can drop the network ───────────────────────────────────

struct Proxy {
    url: String,
    up: Arc<AtomicBool>,
    kill: Arc<tokio::sync::Notify>,
}

impl Proxy {
    async fn start(target: &str) -> Proxy {
        let target = target.to_string();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let up = Arc::new(AtomicBool::new(true));
        let kill = Arc::new(tokio::sync::Notify::new());
        let (up2, kill2) = (up.clone(), kill.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut inbound, _)) = listener.accept().await else { continue };
                if !up2.load(Ordering::SeqCst) {
                    let _ = inbound.shutdown().await;
                    continue;
                }
                let target = target.clone();
                let kill = kill2.clone();
                tokio::spawn(async move {
                    let Ok(mut outbound) = TcpStream::connect(&target).await else { return };
                    tokio::select! {
                        _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound) => {}
                        _ = kill.notified() => {}
                    }
                });
            }
        });
        Proxy { url: format!("http://{addr}"), up, kill }
    }
    fn down(&self) {
        self.up.store(false, Ordering::SeqCst);
        self.kill.notify_waiters();
    }
    fn restore(&self) {
        self.up.store(true, Ordering::SeqCst);
    }
}

fn host_port(url: &str) -> String {
    url.trim_start_matches("http://").trim_end_matches('/').to_string()
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn uploads_a_folder_with_its_structure_and_dates() {
    let base = need_server!();
    let (token, _, cookie) = pair(&base).await;
    let dest = uniq("eng-folder");
    mkdir(&base, &cookie, &dest).await;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("Trip");
    std::fs::create_dir_all(root.join("day 1/raw")).unwrap();
    std::fs::create_dir_all(root.join("empty")).unwrap();
    let files = [("day 1/a.jpg", random(2 * MIB + 333)), ("day 1/raw/b.dng", random(5 * MIB)), ("notes.txt", b"hello".to_vec()), ("zero.bin", vec![])];
    for (p, data) in &files {
        std::fs::write(root.join(p), data).unwrap();
        filetime::set_file_mtime(root.join(p), filetime::FileTime::from_unix_time(1_600_000_000, 0)).unwrap();
    }
    let e = engine_at(&base, &token, &tmp.path().join("q.db"), settings()).await;
    let id = e.upload(UploadRequest { dest_dir: dest.clone(), sources: vec![file_src(&root)], on_conflict: OnConflict::Ask, title: None }).await.unwrap();
    let b = wait_batch(&e, id, 120).await;
    assert_eq!(b.files_done, 4, "{b:?}");
    assert_eq!(b.files_failed, 0);
    for (p, data) in &files {
        let on_server = media().join(&dest).join("Trip").join(p);
        assert_eq!(sha(&std::fs::read(&on_server).unwrap()), sha(data), "{p}");
        let mtime = filetime::FileTime::from_last_modification_time(&std::fs::metadata(&on_server).unwrap());
        assert_eq!(mtime.unix_seconds(), 1_600_000_000, "{p} keeps its date");
    }
    assert!(media().join(&dest).join("Trip/empty").is_dir(), "empty folders are created");
    e.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn name_conflicts_ask_then_replace_skip_or_keep_both() {
    let base = need_server!();
    let (token, _, cookie) = pair(&base).await;
    let dest = uniq("eng-conflict");
    mkdir(&base, &cookie, &dest).await;
    let tmp = tempfile::tempdir().unwrap();
    let e = engine_at(&base, &token, &tmp.path().join("q.db"), settings()).await;
    let up = |name: &str, data: &[u8], policy: OnConflict| {
        let p = tmp.path().join(uniq("src")).join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, data).unwrap();
        let e = e.clone();
        let dest = dest.clone();
        async move { e.upload(UploadRequest { dest_dir: dest, sources: vec![file_src(&p)], on_conflict: policy, title: None }).await.unwrap() }
    };
    wait_batch(&e, up("a.txt", b"one", OnConflict::Ask).await, 30).await;

    // Ask: it waits for a decision.
    let id = up("a.txt", b"two!", OnConflict::Ask).await;
    wait_for("the conflict", 30, || e.conflicts(id).map(|c| c.len() == 1).unwrap_or(false)).await;
    let c = &e.conflicts(id).unwrap()[0];
    assert_eq!(c.relative_path, "a.txt");
    assert_eq!(c.existing_size, Some(3));
    assert!(!c.existing_is_folder);
    e.decide(id, None, OnConflict::Replace).unwrap();
    wait_batch(&e, id, 30).await;
    assert_eq!(std::fs::read(media().join(&dest).join("a.txt")).unwrap(), b"two!");

    // Skip: left alone.
    let id = up("a.txt", b"three", OnConflict::Skip).await;
    let b = wait_batch(&e, id, 30).await;
    assert_eq!(b.files_skipped, 1);
    assert_eq!(std::fs::read(media().join(&dest).join("a.txt")).unwrap(), b"two!");

    // Keep both: a numbered name.
    let id = up("a.txt", b"four", OnConflict::KeepBoth).await;
    wait_batch(&e, id, 30).await;
    assert_eq!(std::fs::read(media().join(&dest).join("a (1).txt")).unwrap(), b"four");
    e.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn resumes_after_the_app_restarts_without_sending_everything_again() {
    let base = need_server!();
    let (token, _, cookie) = pair(&base).await;
    let dest = uniq("eng-resume");
    mkdir(&base, &cookie, &dest).await;
    let tmp = tempfile::tempdir().unwrap();
    let data = random(12 * MIB);
    let src = tmp.path().join("big.bin");
    std::fs::write(&src, &data).unwrap();
    let db = tmp.path().join("q.db");

    // Slowly (2 MiB/s), so there's something left when the app "closes".
    let slow = Settings { speed_limit: 2 * MIB as u64, ..settings() };
    let e = engine_at(&base, &token, &db, slow).await;
    let id = e.upload(UploadRequest { dest_dir: dest.clone(), sources: vec![file_src(&src)], on_conflict: OnConflict::KeepBoth, title: None }).await.unwrap();
    wait_for("some progress", 30, || e.batches(true).unwrap()[0].bytes_done > 3 * MIB as i64).await;
    e.shutdown().await;
    drop(e);

    // The next start continues from what the server has.
    let e = engine_at(&base, &token, &db, settings()).await;
    let item = &e.items(id, 0, 1).unwrap()[0];
    assert!(item.bytes_done >= 3 * MIB as i64, "progress was kept: {item:?}");
    let b = wait_batch(&e, id, 60).await;
    assert_eq!(b.files_done, 1);
    assert_eq!(sha(&std::fs::read(media().join(&dest).join("big.bin")).unwrap()), sha(&data));
    assert_eq!(std::fs::read_dir(media().join(&dest)).unwrap().count(), 1, "no duplicate");
    e.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn survives_the_network_going_away() {
    let base = need_server!();
    let (token, _, cookie) = pair(&base).await;
    let dest = uniq("eng-net");
    mkdir(&base, &cookie, &dest).await;
    let proxy = Proxy::start(&host_port(&base)).await;
    let tmp = tempfile::tempdir().unwrap();
    let data = random(8 * MIB);
    let src = tmp.path().join("v.bin");
    std::fs::write(&src, &data).unwrap();
    // Only the (cuttable) public address: no LAN shortcut around the proxy.
    let no_lan = Settings { speed_limit: 2 * MIB as u64, use_lan: false, ..settings() };
    let e = engine_at(&proxy.url, &token, &tmp.path().join("q.db"), no_lan.clone()).await;
    let id = e.upload(UploadRequest { dest_dir: dest.clone(), sources: vec![file_src(&src)], on_conflict: OnConflict::KeepBoth, title: None }).await.unwrap();
    wait_for("some progress", 30, || e.batches(true).unwrap()[0].bytes_done > 2 * MIB as i64).await;
    assert_eq!(e.api().via(), Via::Internet);

    proxy.down();
    wait_for("the engine to notice", 60, || {
        let s = e.snapshot();
        s.offline || s.waiting > 0
    })
    .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let b = e.batches(true).unwrap().into_iter().find(|b| b.id == id).unwrap();
    assert_ne!(b.state, "done");
    assert_eq!(b.files_failed, 0, "network trouble never fails a transfer");

    proxy.restore();
    e.set_settings(Settings { speed_limit: 0, ..no_lan });
    let b = wait_batch(&e, id, 180).await;
    assert_eq!(b.files_done, 1);
    assert_eq!(sha(&std::fs::read(media().join(&dest).join("v.bin")).unwrap()), sha(&data));
    e.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn uses_the_lan_address_when_it_answers() {
    let base = need_server!();
    let (token, _, cookie) = pair(&base).await;
    let dest = uniq("eng-lan");
    mkdir(&base, &cookie, &dest).await;
    let tmp = tempfile::tempdir().unwrap();
    let e = engine_at(&base, &token, &tmp.path().join("q.db"), settings()).await;
    wait_for("the LAN probe", 30, || e.snapshot().via.as_deref() == Some("lan")).await;
    let data = random(3 * MIB);
    let src = tmp.path().join("lan.bin");
    std::fs::write(&src, &data).unwrap();
    let id = e.upload(UploadRequest { dest_dir: dest.clone(), sources: vec![file_src(&src)], on_conflict: OnConflict::KeepBoth, title: None }).await.unwrap();
    wait_batch(&e, id, 60).await;
    assert_eq!(sha(&std::fs::read(media().join(&dest).join("lan.bin")).unwrap()), sha(&data));
    assert_eq!(e.api().via(), Via::Lan);
    e.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn falls_back_to_the_internet_when_the_lan_stops_answering() {
    let base = need_server!();
    let (token, _, _) = pair(&base).await;
    // The LAN listener, behind a proxy we can cut (same IP, so the certificate still fits).
    let probe = Api::new(ServerConfig { public_url: base.clone(), token: token.clone(), instance_id: None, lan: None }, "t").unwrap();
    let info = probe.client_info().await.unwrap();
    let lan = info.lan.expect("the test stack has LAN access");
    let lan_proxy = Proxy::start(lan.url.trim_start_matches("https://")).await;
    let lan_url = lan_proxy.url.replace("http://", "https://");
    let api = Api::new(
        ServerConfig {
            public_url: base.clone(),
            token,
            instance_id: Some(info.instance_id.clone()),
            lan: Some(LanConfig { url: lan_url, ca_pem: lan.ca_pem }),
        },
        "t",
    )
    .unwrap();
    assert!(api.probe_lan(true).await, "LAN reachable through the proxy");
    assert_eq!(api.via(), Via::Lan);
    assert!(api.list("").await.is_ok());
    lan_proxy.down();
    // The next request notices, switches, and still succeeds.
    assert!(api.list("").await.is_ok(), "falls back within the same request");
    assert_eq!(api.via(), Via::Internet);
    assert!(!api.probe_lan(true).await);
    lan_proxy.restore();
    assert!(api.probe_lan(true).await, "and goes back when it answers again");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lan_with_the_wrong_certificate_is_never_used() {
    let base = need_server!();
    let (token, _, _) = pair(&base).await;
    let probe = Api::new(ServerConfig { public_url: base.clone(), token: token.clone(), instance_id: None, lan: None }, "t").unwrap();
    let info = probe.client_info().await.unwrap();
    let lan = info.lan.unwrap();
    // A real, valid certificate authority, just not the server's.
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    params.distinguished_name.push(rcgen::DnType::CommonName, "Some other CA");
    let other_ca = params.self_signed(&rcgen::KeyPair::generate().unwrap()).unwrap().pem();
    let api = Api::new(
        ServerConfig { public_url: base, token, instance_id: Some(info.instance_id), lan: Some(LanConfig { url: lan.url, ca_pem: other_ca }) },
        "t",
    );
    let api = api.expect("a valid certificate is accepted as configuration");
    assert!(!api.probe_lan(true).await, "but the server's certificate doesn't verify against it");
    assert_eq!(api.via(), Via::Internet);
    assert!(api.list("").await.is_ok(), "and everything goes over the internet address");
}

#[tokio::test(flavor = "multi_thread")]
async fn downloads_a_folder_and_resumes_a_partial_file() {
    let base = need_server!();
    let (token, _, cookie) = pair(&base).await;
    let dest = uniq("eng-dl");
    mkdir(&base, &cookie, &dest).await;
    let tmp = tempfile::tempdir().unwrap();
    // Put something in Loom first.
    let up = tmp.path().join("Album");
    std::fs::create_dir_all(up.join("inner")).unwrap();
    let big = random(9 * MIB);
    std::fs::write(up.join("inner/big.bin"), &big).unwrap();
    std::fs::write(up.join("small: name?.txt"), b"tiny").unwrap();
    let e = engine_at(&base, &token, &tmp.path().join("q.db"), settings()).await;
    let id = e.upload(UploadRequest { dest_dir: dest.clone(), sources: vec![file_src(&up)], on_conflict: OnConflict::KeepBoth, title: None }).await.unwrap();
    wait_batch(&e, id, 60).await;
    e.shutdown().await;
    drop(e);

    // Download it slowly, stop half way, then finish in a new engine.
    let out = tmp.path().join("Downloads");
    let db = tmp.path().join("dl.db");
    let e = engine_at(&base, &token, &db, Settings { speed_limit: 3 * MIB as u64, ..settings() }).await;
    let id = e
        .download(DownloadRequest { entries: vec![RemoteEntry { path: format!("{dest}/Album"), name: "Album".into(), is_dir: true }], local_dir: out.clone(), title: None })
        .await
        .unwrap();
    wait_for("some progress", 30, || e.batches(true).unwrap().iter().find(|b| b.id == id).map(|b| b.bytes_done > 3 * MIB as i64).unwrap_or(false)).await;
    e.shutdown().await;
    drop(e);
    let part = out.join("Album/inner/big.bin.loomdownload");
    assert!(part.exists(), "a partial download is kept");
    let partial = std::fs::metadata(&part).unwrap().len();
    assert!(partial > 0 && partial < big.len() as u64);

    let e = engine_at(&base, &token, &db, settings()).await;
    let b = wait_batch(&e, id, 60).await;
    assert_eq!(b.files_done, 2, "{b:?}");
    assert_eq!(sha(&std::fs::read(out.join("Album/inner/big.bin")).unwrap()), sha(&big));
    assert!(!part.exists());
    // A name Windows can't have is made safe (on every platform, so a folder
    // downloaded on Linux and copied to Windows still works).
    assert_eq!(std::fs::read(out.join("Album").join("small_ name_.txt")).unwrap(), b"tiny");
    e.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_changed_mid_upload_is_sent_again_in_its_new_version() {
    let base = need_server!();
    let (token, _, cookie) = pair(&base).await;
    let dest = uniq("eng-change");
    mkdir(&base, &cookie, &dest).await;
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("doc.bin");
    std::fs::write(&src, random(8 * MIB)).unwrap();
    let e = engine_at(&base, &token, &tmp.path().join("q.db"), Settings { speed_limit: 2 * MIB as u64, parallel_chunks: 1, ..settings() }).await;
    let id = e.upload(UploadRequest { dest_dir: dest.clone(), sources: vec![file_src(&src)], on_conflict: OnConflict::KeepBoth, title: None }).await.unwrap();
    wait_for("some progress", 30, || e.batches(true).unwrap()[0].bytes_done > 2 * MIB as i64).await;
    let newer = random(5 * MIB);
    std::fs::write(&src, &newer).unwrap();
    filetime::set_file_mtime(&src, filetime::FileTime::from_unix_time(1_700_000_000, 0)).unwrap();
    e.set_settings(settings());
    let b = wait_batch(&e, id, 120).await;
    assert_eq!(b.files_done, 1, "{b:?}");
    assert_eq!(sha(&std::fs::read(media().join(&dest).join("doc.bin")).unwrap()), sha(&newer));
    e.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_discards_the_server_side_upload() {
    let base = need_server!();
    let (token, _, cookie) = pair(&base).await;
    let dest = uniq("eng-cancel");
    mkdir(&base, &cookie, &dest).await;
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("c.bin");
    std::fs::write(&src, random(10 * MIB)).unwrap();
    let db = tmp.path().join("q.db");
    let e = engine_at(&base, &token, &db, Settings { speed_limit: MIB as u64, ..settings() }).await;
    let id = e.upload(UploadRequest { dest_dir: dest.clone(), sources: vec![file_src(&src)], on_conflict: OnConflict::KeepBoth, title: None }).await.unwrap();
    wait_for("an upload session", 30, || e.batches(true).unwrap()[0].bytes_done > MIB as i64).await;
    let store = Store::open(&db).unwrap();
    let item = store.items(id, 0, 1).unwrap()[0].id;
    let session = store.get_item(item).unwrap().unwrap().session_id.expect("session");
    e.cancel(id, None).await.unwrap();
    let b = wait_batch(&e, id, 10).await;
    assert_eq!(b.state, "cancelled");
    assert!(e.api().get_session(&session).await.is_err(), "the server forgot it");
    assert_eq!(std::fs::read_dir(media().join(&dest)).unwrap().count(), 0);
    e.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn pause_all_and_resume() {
    let base = need_server!();
    let (token, _, cookie) = pair(&base).await;
    let dest = uniq("eng-pause");
    mkdir(&base, &cookie, &dest).await;
    let tmp = tempfile::tempdir().unwrap();
    let data = random(6 * MIB);
    let src = tmp.path().join("p.bin");
    std::fs::write(&src, &data).unwrap();
    let e = engine_at(&base, &token, &tmp.path().join("q.db"), Settings { speed_limit: 2 * MIB as u64, ..settings() }).await;
    let id = e.upload(UploadRequest { dest_dir: dest.clone(), sources: vec![file_src(&src)], on_conflict: OnConflict::KeepBoth, title: None }).await.unwrap();
    wait_for("some progress", 30, || e.batches(true).unwrap()[0].bytes_done > MIB as i64).await;
    e.pause(None).unwrap();
    wait_for("everything to stop", 10, || e.snapshot().active == 0).await;
    let before = e.batches(true).unwrap()[0].bytes_done;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let after = e.batches(true).unwrap()[0].bytes_done;
    assert!(after - before < MIB as i64, "nothing moves while paused ({before} → {after})");
    assert!(e.snapshot().all_paused);
    e.resume(None).unwrap();
    e.set_settings(settings());
    wait_batch(&e, id, 60).await;
    assert_eq!(sha(&std::fs::read(media().join(&dest).join("p.bin")).unwrap()), sha(&data));
    e.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_file_fails_clearly_and_can_be_retried() {
    let base = need_server!();
    let (token, _, cookie) = pair(&base).await;
    let dest = uniq("eng-missing");
    mkdir(&base, &cookie, &dest).await;
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("gone.txt");
    std::fs::write(&src, b"x").unwrap();
    let e = engine_at(&base, &token, &tmp.path().join("q.db"), settings()).await;
    e.pause(None).unwrap();
    let id = e.upload(UploadRequest { dest_dir: dest.clone(), sources: vec![file_src(&src)], on_conflict: OnConflict::KeepBoth, title: None }).await.unwrap();
    wait_for("the scan", 10, || e.items(id, 0, 1).map(|v| v.len() == 1).unwrap_or(false)).await;
    std::fs::remove_file(&src).unwrap();
    e.resume(None).unwrap();
    let b = wait_batch(&e, id, 30).await;
    assert_eq!(b.files_failed, 1);
    let it = &e.items(id, 0, 1).unwrap()[0];
    assert_eq!(it.state, ItemState::Failed);
    assert!(it.error.as_deref().unwrap_or("").contains("moved or deleted"), "{it:?}");
    std::fs::write(&src, b"back").unwrap();
    e.retry(Some(id), None).unwrap();
    let b = wait_batch(&e, id, 30).await;
    assert_eq!(b.files_done, 1, "{b:?}");
    assert_eq!(std::fs::read(media().join(&dest).join("gone.txt")).unwrap(), b"back");
    e.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_removed_device_stops_and_says_so() {
    let base = need_server!();
    let (token, device, cookie) = pair_new(&base).await;
    let tmp = tempfile::tempdir().unwrap();
    let e = engine_at(&base, &token, &tmp.path().join("q.db"), settings()).await;
    let mut events = e.events();
    reqwest::Client::new().delete(format!("{base}/api/devices/{device}")).header("cookie", &cookie).send().await.unwrap();
    tokio::time::sleep(Duration::from_secs(16)).await; // the server's 15 s token cache
    let src = tmp.path().join("x.txt");
    std::fs::write(&src, b"x").unwrap();
    let _ = e.upload(UploadRequest { dest_dir: String::new(), sources: vec![file_src(&src)], on_conflict: OnConflict::KeepBoth, title: None }).await.unwrap();
    wait_for("signed out", 30, || e.snapshot().signed_out).await;
    let mut saw = false;
    while let Ok(ev) = events.try_recv() {
        saw |= matches!(ev, Event::SignedOut);
    }
    assert!(saw, "the app is told");
    e.shutdown().await;
}
