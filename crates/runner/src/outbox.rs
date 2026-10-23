//! Event 的本機暫存與補送（ARCHITECTURE §14）。
//!
//! - 每個 Run 的 Event 依 seq 連續編號，先寫進 `<狀態目錄>/spool/<run_id>.jsonl` 再送出，
//!   斷線或 Runner 重新啟動後仍能補送。
//! - Server 以 `event_ack` 回報已連續保存的最大 seq，Runner 據此清除暫存。
//! - 重新連線時依 `hello_ack.resume` 從 `last_seq + 1` 補送；`resume` 沒有列出的 Run 已不屬於
//!   這台 Runner，清除它的暫存（並由呼叫端中止 Run）。
//! - 大型文字內容（超過 [`INLINE_LIMIT`]）改存成 blob，Event 中只放參照；blob 一律先上傳成功，
//!   才送出參照它的 Event。

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::Context;
use orbis_protocol::connection::RunResume;
use orbis_protocol::event::{
    BlobRef, EventEnvelope, EventFrame, EventKind, TextBody, ToolCallContent,
};
use orbis_protocol::ids::{BlobId, DispatchId, RunId};
use orbis_protocol::verification::VerificationEvidence;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::repo_config::sha256_hex;

/// 內嵌與 blob 的門檻：超過 64 KiB 的文字改送 blob 參照。
pub const INLINE_LIMIT: usize = 64 * 1024;

/// 文字 blob 的 media type。
pub const TEXT_MEDIA_TYPE: &str = "text/plain; charset=utf-8";

/// 暫存檔中的一行。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Spooled {
    pub frame: EventFrame,
    /// 這筆 Event 參照的 blob（送出前要先上傳）。
    #[serde(default)]
    pub blobs: Vec<BlobRef>,
}

#[derive(Debug)]
struct RunSpool {
    dispatch_id: DispatchId,
    next_seq: u64,
    /// 尚未被 ack 的 Event，依 seq 排序。
    pending: VecDeque<Spooled>,
    /// 目前這條連線上已送出的最大 seq。
    sent_upto: u64,
    acked: u64,
    /// Run 已經結束：全部 ack 之後就刪掉暫存。
    finished: bool,
}

/// 所有 Run 的暫存。
#[derive(Debug)]
pub struct Outbox {
    dir: PathBuf,
    runs: Mutex<BTreeMap<RunId, RunSpool>>,
    uploaded: Mutex<HashSet<BlobId>>,
    notify: Notify,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Outbox {
    /// 開啟暫存目錄，載入上次沒送完的 Event。
    pub fn open(dir: impl Into<PathBuf>) -> anyhow::Result<Self> {
        let dir = dir.into();
        std::fs::create_dir_all(dir.join("blobs"))
            .with_context(|| format!("無法建立 {}", dir.display()))?;
        let mut runs = BTreeMap::new();
        for entry in std::fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let text = std::fs::read_to_string(&path)?;
            let pending: VecDeque<Spooled> = text
                .lines()
                .filter(|l| !l.trim().is_empty())
                .filter_map(|l| match serde_json::from_str(l) {
                    Ok(item) => Some(item),
                    Err(e) => {
                        tracing::warn!(file = %path.display(), error = %e, "略過壞掉的暫存行");
                        None
                    }
                })
                .collect();
            let Some(last) = pending.back() else {
                let _ = std::fs::remove_file(&path);
                continue;
            };
            let first_seq = pending.front().map_or(1, |s| s.frame.event.seq);
            runs.insert(
                last.frame.event.run_id.clone(),
                RunSpool {
                    dispatch_id: last.frame.dispatch_id.clone(),
                    next_seq: last.frame.event.seq + 1,
                    sent_upto: first_seq - 1,
                    acked: first_seq - 1,
                    pending,
                    finished: true,
                },
            );
        }
        Ok(Self {
            dir,
            runs: Mutex::new(runs),
            uploaded: Mutex::new(HashSet::new()),
            notify: Notify::new(),
        })
    }

    /// 上次 Runner 結束時還沒送完的 Run（Run 本身已經不在了）。
    pub fn recovered_runs(&self) -> Vec<(RunId, DispatchId, Option<EventKind>)> {
        lock(&self.runs)
            .iter()
            .map(|(id, spool)| {
                (
                    id.clone(),
                    spool.dispatch_id.clone(),
                    spool.pending.back().map(|s| s.frame.event.kind.clone()),
                )
            })
            .collect()
    }

    fn spool_file(&self, run_id: &RunId) -> PathBuf {
        self.dir
            .join(format!("{}.jsonl", file_safe(run_id.as_str())))
    }

    fn blob_file(&self, blob_id: &BlobId) -> PathBuf {
        self.dir.join("blobs").join(file_safe(blob_id.as_str()))
    }

    /// 開始記錄一個 Run 的 Event。`first_seq` 是 DispatchOffer 的 `last_event_seq + 1`。
    /// 同一個 Run 再次派到這台 Runner 時沿用原本的暫存，改用新的 Dispatch。
    pub fn open_run(&self, run_id: &RunId, dispatch_id: &DispatchId, first_seq: u64) {
        let mut runs = lock(&self.runs);
        let spool = runs.entry(run_id.clone()).or_insert_with(|| RunSpool {
            dispatch_id: dispatch_id.clone(),
            next_seq: first_seq,
            pending: VecDeque::new(),
            sent_upto: first_seq - 1,
            acked: first_seq - 1,
            finished: false,
        });
        spool.dispatch_id = dispatch_id.clone();
        spool.next_seq = spool.next_seq.max(first_seq);
        spool.finished = false;
        // 新的 Dispatch 之前沒送出的 Event 屬於舊 Dispatch，Server 會拒絕；丟掉它們。
        spool
            .pending
            .retain(|s| &s.frame.dispatch_id == dispatch_id);
    }

    /// 記錄一筆 Event（大型內容改成 blob）並排入待送。回傳它的 seq。
    pub fn emit(
        &self,
        run_id: &RunId,
        ts: orbis_protocol::ids::Timestamp,
        kind: EventKind,
    ) -> anyhow::Result<u64> {
        let (kind, blobs) = self.externalize(kind)?;
        let mut runs = lock(&self.runs);
        let spool = runs
            .get_mut(run_id)
            .with_context(|| format!("Run {run_id} 沒有開啟暫存"))?;
        let seq = spool.next_seq;
        let item = Spooled {
            frame: EventFrame {
                dispatch_id: spool.dispatch_id.clone(),
                event: EventEnvelope {
                    run_id: run_id.clone(),
                    seq,
                    ts,
                    kind,
                },
            },
            blobs,
        };
        let mut line = serde_json::to_string(&item)?;
        line.push('\n');
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.spool_file(run_id))
            .and_then(|mut f| f.write_all(line.as_bytes()))
            .context("無法寫入 Event 暫存")?;
        spool.next_seq += 1;
        spool.pending.push_back(item);
        drop(runs);
        self.notify.notify_one();
        Ok(seq)
    }

    /// Run 已經結束：全部 ack 之後刪除暫存。
    pub fn finish_run(&self, run_id: &RunId) {
        let mut runs = lock(&self.runs);
        if let Some(spool) = runs.get_mut(run_id) {
            spool.finished = true;
            if spool.pending.is_empty() {
                runs.remove(run_id);
                let _ = std::fs::remove_file(self.spool_file(run_id));
            }
        }
    }

    /// 新的連線完成交握：依 `resume` 設定每個 Run 已被 Server 保存的位置，之後從下一個 seq 補送。
    /// 回傳 `resume` 沒有列出、已不屬於這台 Runner 的 Run（暫存已清除）。
    pub fn begin_connection(&self, resume: &[RunResume]) -> Vec<RunId> {
        let mut orphaned = Vec::new();
        let mut runs = lock(&self.runs);
        let ids: Vec<RunId> = runs.keys().cloned().collect();
        for id in ids {
            match resume.iter().find(|r| r.run_id == id) {
                Some(r) => {
                    let spool = runs.get_mut(&id).expect("剛剛列出的 Run");
                    spool.acked = spool.acked.max(r.last_seq);
                    spool.sent_upto = spool.acked;
                }
                None => orphaned.push(id),
            }
        }
        drop(runs);
        for id in &orphaned {
            self.drop_run(id);
        }
        for r in resume {
            self.ack(&r.run_id, r.last_seq);
        }
        self.notify.notify_one();
        orphaned
    }

    /// 清除一個 Run 的所有暫存。
    pub fn drop_run(&self, run_id: &RunId) {
        let removed = lock(&self.runs).remove(run_id);
        if let Some(spool) = removed {
            for item in spool.pending {
                for blob in item.blobs {
                    let _ = std::fs::remove_file(self.blob_file(&blob.blob_id));
                }
            }
        }
        let _ = std::fs::remove_file(self.spool_file(run_id));
    }

    /// 下一筆還沒在這條連線上送出的 Event。
    pub fn next_unsent(&self) -> Option<Spooled> {
        lock(&self.runs).values().find_map(|spool| {
            spool
                .pending
                .iter()
                .find(|s| s.frame.event.seq > spool.sent_upto)
                .cloned()
        })
    }

    pub fn mark_sent(&self, run_id: &RunId, seq: u64) {
        if let Some(spool) = lock(&self.runs).get_mut(run_id) {
            spool.sent_upto = spool.sent_upto.max(seq);
        }
    }

    /// Server 已連續保存到 `seq`：清除這之前的暫存。
    pub fn ack(&self, run_id: &RunId, seq: u64) {
        let mut runs = lock(&self.runs);
        let Some(spool) = runs.get_mut(run_id) else {
            return;
        };
        spool.acked = spool.acked.max(seq);
        let before = spool.pending.len();
        let mut freed = Vec::new();
        while spool
            .pending
            .front()
            .is_some_and(|s| s.frame.event.seq <= seq)
        {
            let item = spool.pending.pop_front().expect("剛剛檢查過");
            freed.extend(item.blobs.into_iter().map(|b| b.blob_id));
        }
        if spool.pending.len() == before {
            return;
        }
        let path = self.spool_file(run_id);
        if spool.pending.is_empty() && spool.finished {
            runs.remove(run_id);
            let _ = std::fs::remove_file(&path);
        } else {
            let text: String = spool
                .pending
                .iter()
                .filter_map(|s| serde_json::to_string(s).ok())
                .map(|l| l + "\n")
                .collect();
            if let Err(e) = crate::home::write_atomic(&path, text.as_bytes(), false) {
                tracing::warn!(error = %e, "無法改寫 Event 暫存");
            }
        }
        drop(runs);
        for blob in freed {
            let _ = std::fs::remove_file(self.blob_file(&blob));
            lock(&self.uploaded).remove(&blob);
        }
    }

    /// 這個 Run 是否還有沒被 ack 的 Event。
    pub fn has_pending(&self, run_id: &RunId) -> bool {
        lock(&self.runs)
            .get(run_id)
            .is_some_and(|s| !s.pending.is_empty())
    }

    /// 等到有新的 Event 可以送。
    pub async fn notified(&self) {
        self.notify.notified().await;
    }

    pub fn is_uploaded(&self, blob: &BlobId) -> bool {
        lock(&self.uploaded).contains(blob)
    }

    pub fn mark_uploaded(&self, blob: &BlobId) {
        lock(&self.uploaded).insert(blob.clone());
    }

    /// 讀取 blob 的內容（上傳用）。
    pub fn blob_bytes(&self, blob: &BlobId) -> anyhow::Result<Vec<u8>> {
        let path = self.blob_file(blob);
        std::fs::read(&path).with_context(|| format!("讀不到 blob {}", path.display()))
    }

    /// 把檔案內容（例如 Verification 的截圖）存成 blob，回傳參照；參照它的 Event 送出前會先上傳。
    pub fn store_blob(&self, bytes: &[u8], media_type: &str) -> anyhow::Result<BlobRef> {
        let blob = BlobRef {
            blob_id: uuid::Uuid::now_v7().to_string().into(),
            sha256: sha256_hex(bytes),
            size: bytes.len() as u64,
            media_type: media_type.into(),
        };
        crate::home::write_atomic(&self.blob_file(&blob.blob_id), bytes, false)?;
        Ok(blob)
    }

    /// 把大型的 `TextBody` 改存成 blob。
    fn externalize(&self, kind: EventKind) -> anyhow::Result<(EventKind, Vec<BlobRef>)> {
        let mut blobs = Vec::new();
        let mut convert = |body: &mut Option<TextBody>| -> anyhow::Result<()> {
            if let Some(b) = body {
                self.externalize_body(b, &mut blobs)?;
            }
            Ok(())
        };
        let mut stored = Vec::new();
        let mut kind = kind;
        match &mut kind {
            EventKind::ToolCall(call) => {
                for content in call.content.iter_mut().flatten() {
                    match content {
                        ToolCallContent::Diff { old, new, .. } => {
                            convert(old)?;
                            convert(new)?;
                        }
                        ToolCallContent::Terminal { output, .. } => {
                            let mut wrapped = Some(output.clone());
                            convert(&mut wrapped)?;
                            *output = wrapped.expect("剛剛放進去的");
                        }
                        ToolCallContent::Text { .. } => {}
                    }
                }
            }
            EventKind::RunDiff(diff) => {
                for file in &mut diff.files {
                    convert(&mut file.old)?;
                    convert(&mut file.new)?;
                }
            }
            EventKind::PlanProposed { body, .. } | EventKind::FinalMessage { text: body } => {
                let mut wrapped = Some(body.clone());
                convert(&mut wrapped)?;
                *body = wrapped.expect("剛剛放進去的");
            }
            EventKind::VerificationResult(result) => {
                for evidence in &mut result.evidence {
                    match evidence {
                        VerificationEvidence::CommandOutput { output, .. } => {
                            let mut wrapped = Some(output.clone());
                            convert(&mut wrapped)?;
                            *output = wrapped.expect("剛剛放進去的");
                        }
                        // 截圖已經以 store_blob 存好，這裡只列入要上傳的 blob。
                        VerificationEvidence::Screenshot { image, .. } => {
                            stored.push(image.clone());
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        blobs.extend(stored);
        Ok((kind, blobs))
    }

    fn externalize_body(
        &self,
        body: &mut TextBody,
        blobs: &mut Vec<BlobRef>,
    ) -> anyhow::Result<()> {
        let TextBody::Inline { text } = body else {
            return Ok(());
        };
        if text.len() <= INLINE_LIMIT {
            return Ok(());
        }
        let bytes = std::mem::take(text).into_bytes();
        let blob = BlobRef {
            blob_id: uuid::Uuid::now_v7().to_string().into(),
            sha256: sha256_hex(&bytes),
            size: bytes.len() as u64,
            media_type: TEXT_MEDIA_TYPE.into(),
        };
        crate::home::write_atomic(&self.blob_file(&blob.blob_id), &bytes, false)?;
        blobs.push(blob.clone());
        *body = TextBody::Blob(blob);
        Ok(())
    }
}

/// 檔名只保留安全的字元（ID 是 UUID，這只是防禦）。
fn file_safe(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 測試用：暫存目錄中的檔案。
pub fn spool_files(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use orbis_protocol::event::{ToolCall, ToolCallStatus, ToolKind};

    use super::*;

    fn outbox() -> (tempfile::TempDir, Outbox) {
        let dir = tempfile::Builder::new()
            .prefix("orbis outbox ")
            .tempdir()
            .unwrap();
        let outbox = Outbox::open(dir.path().join("spool")).unwrap();
        (dir, outbox)
    }

    fn thought(text: &str) -> EventKind {
        EventKind::ThoughtChunk { text: text.into() }
    }

    fn ts() -> orbis_protocol::ids::Timestamp {
        "2026-10-23T08:00:00.000Z".into()
    }

    #[test]
    fn seq_從_offer_的下一個開始連續編號() {
        let (_d, outbox) = outbox();
        let run: RunId = "r1".into();
        outbox.open_run(&run, &"d1".into(), 6);
        assert_eq!(outbox.emit(&run, ts(), thought("a")).unwrap(), 6);
        assert_eq!(outbox.emit(&run, ts(), thought("b")).unwrap(), 7);
        let next = outbox.next_unsent().unwrap();
        assert_eq!(next.frame.event.seq, 6);
        assert_eq!(next.frame.dispatch_id.as_str(), "d1");
        outbox.mark_sent(&run, 6);
        assert_eq!(outbox.next_unsent().unwrap().frame.event.seq, 7);
        outbox.mark_sent(&run, 7);
        assert!(outbox.next_unsent().is_none());
    }

    #[test]
    fn ack_後清除暫存_重新連線從_last_seq_補送() {
        let (dir, outbox) = outbox();
        let run: RunId = "r1".into();
        outbox.open_run(&run, &"d1".into(), 1);
        for t in ["a", "b", "c"] {
            outbox.emit(&run, ts(), thought(t)).unwrap();
        }
        for seq in 1..=3 {
            outbox.mark_sent(&run, seq);
        }
        outbox.ack(&run, 1);
        // 斷線：Server 只保存到 2。
        let orphaned = outbox.begin_connection(&[RunResume {
            run_id: run.clone(),
            last_seq: 2,
        }]);
        assert!(orphaned.is_empty());
        let next = outbox.next_unsent().unwrap();
        assert_eq!(next.frame.event.seq, 3, "從 last_seq + 1 補送");
        outbox.mark_sent(&run, 3);
        outbox.ack(&run, 3);
        assert!(!outbox.has_pending(&run));
        outbox.finish_run(&run);
        assert!(
            spool_files(&dir.path().join("spool")).is_empty(),
            "全部 ack 後刪除暫存檔"
        );
    }

    #[test]
    fn resume_沒有列出的_run_會被清除() {
        let (_d, outbox) = outbox();
        let run: RunId = "r1".into();
        outbox.open_run(&run, &"d1".into(), 1);
        outbox.emit(&run, ts(), thought("a")).unwrap();
        let orphaned = outbox.begin_connection(&[]);
        assert_eq!(orphaned, std::slice::from_ref(&run));
        assert!(outbox.next_unsent().is_none());
    }

    #[test]
    fn runner_重新啟動後載入沒送完的_event() {
        let dir = tempfile::Builder::new()
            .prefix("orbis outbox ")
            .tempdir()
            .unwrap();
        let spool = dir.path().join("spool");
        {
            let outbox = Outbox::open(&spool).unwrap();
            let run: RunId = "r1".into();
            outbox.open_run(&run, &"d1".into(), 1);
            outbox.emit(&run, ts(), thought("a")).unwrap();
            outbox.emit(&run, ts(), thought("b")).unwrap();
            outbox.ack(&run, 1);
        }
        let outbox = Outbox::open(&spool).unwrap();
        let recovered = outbox.recovered_runs();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].1.as_str(), "d1");
        outbox.begin_connection(&[RunResume {
            run_id: "r1".into(),
            last_seq: 1,
        }]);
        assert_eq!(outbox.next_unsent().unwrap().frame.event.seq, 2);
        // 接續編號
        assert_eq!(outbox.emit(&"r1".into(), ts(), thought("c")).unwrap(), 3);
    }

    #[test]
    fn 大型內容改成_blob() {
        let (_d, outbox) = outbox();
        let run: RunId = "r1".into();
        outbox.open_run(&run, &"d1".into(), 1);
        let big = "x".repeat(INLINE_LIMIT + 1);
        let kind = EventKind::ToolCall(ToolCall {
            tool_call_id: "t1".into(),
            title: Some("編輯".into()),
            tool_kind: Some(ToolKind::Edit),
            status: Some(ToolCallStatus::Completed),
            content: Some(vec![ToolCallContent::Diff {
                path: "a.txt".into(),
                old: Some(TextBody::Inline { text: "小".into() }),
                new: Some(TextBody::Inline { text: big.clone() }),
            }]),
            locations: None,
        });
        outbox.emit(&run, ts(), kind).unwrap();
        let item = outbox.next_unsent().unwrap();
        assert_eq!(item.blobs.len(), 1);
        let blob = &item.blobs[0];
        assert_eq!(blob.size, big.len() as u64);
        assert_eq!(blob.sha256, sha256_hex(big.as_bytes()));
        assert_eq!(outbox.blob_bytes(&blob.blob_id).unwrap(), big.as_bytes());
        let EventKind::ToolCall(call) = &item.frame.event.kind else {
            panic!()
        };
        let ToolCallContent::Diff { old, new, .. } = &call.content.as_ref().unwrap()[0] else {
            panic!()
        };
        assert!(
            matches!(old, Some(TextBody::Inline { .. })),
            "小的內容維持內嵌"
        );
        assert!(matches!(new, Some(TextBody::Blob(_))));
        // ack 後刪除 blob
        outbox.ack(&run, 1);
        assert!(outbox.blob_bytes(&blob.blob_id).is_err());
    }

    #[test]
    fn 改派時丟掉舊_dispatch_沒送出的_event() {
        let (_d, outbox) = outbox();
        let run: RunId = "r1".into();
        outbox.open_run(&run, &"d1".into(), 1);
        outbox.emit(&run, ts(), thought("a")).unwrap();
        outbox.open_run(&run, &"d2".into(), 1);
        assert!(outbox.next_unsent().is_none());
        assert_eq!(outbox.emit(&run, ts(), thought("b")).unwrap(), 2);
        assert_eq!(
            outbox.next_unsent().unwrap().frame.dispatch_id.as_str(),
            "d2"
        );
    }
}
