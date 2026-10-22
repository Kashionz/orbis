//! 產生 `packages/protocol` 的 TS 型別。
//!
//! - `generated/*.ts`：ts-rs 產生的型別，每個型別一個檔案。
//! - `generated/index.ts`：重新匯出所有型別。
//! - `generated/constants.ts`：協定版本與列舉的值陣列（ts-rs 只產生型別，不產生值）。
//!
//! 執行 `cargo gen-protocol`（或 `pnpm gen:protocol`）重新產生；
//! `tests/generated_up_to_date.rs` 會在產生結果與 commit 的版本不一致時失敗。

use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use ts_rs::{Config, TS};

use crate::enums::{
    DelegationMode, GateDecision, GateKind, PermissionPolicy, RunStatus, RunnerKind,
};
use crate::frame::{RunnerToServer, ServerToRunner};
use crate::names::Names;

const HEADER: &str = "// 由 crates/orbis-protocol 產生（cargo gen-protocol），不可手改。\n";

/// 產生結果在 repo 中的位置。
pub fn default_out_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/src/generated")
}

/// 清空 `out_dir` 後重新產生所有檔案。
pub fn generate(out_dir: &Path) -> io::Result<()> {
    if out_dir.exists() {
        fs::remove_dir_all(out_dir)?;
    }
    fs::create_dir_all(out_dir)?;

    let cfg = Config::new()
        .with_out_dir(out_dir)
        // seq、大小、token 數都遠小於 2^53，在 TS 端用 number，不用 bigint。
        .with_large_int("number");

    export_roots(&cfg).map_err(io::Error::other)?;

    let mut modules: Vec<String> = fs::read_dir(out_dir)?
        .filter_map(|entry| {
            let name = entry.ok()?.file_name().into_string().ok()?;
            name.strip_suffix(".ts").map(str::to_owned)
        })
        .collect();
    modules.sort();

    let mut index = String::from(HEADER);
    for module in &modules {
        writeln!(index, "export type * from \"./{module}\";").unwrap();
    }
    index.push_str("export * from \"./constants\";\n");
    fs::write(out_dir.join("index.ts"), index)?;

    fs::write(out_dir.join("constants.ts"), constants())?;
    Ok(())
}

/// 所有要匯出的根型別；它們依賴的型別會一併匯出。
/// 新增協定型別時，只要它能從這些根型別到達就會被匯出；獨立的型別要加在這裡。
fn export_roots(cfg: &Config) -> Result<(), ts_rs::ExportError> {
    RunnerToServer::export_all(cfg)?;
    ServerToRunner::export_all(cfg)?;
    Names::export_all(cfg)?;
    RunStatus::export_all(cfg)?;
    PermissionPolicy::export_all(cfg)?;
    DelegationMode::export_all(cfg)?;
    RunnerKind::export_all(cfg)?;
    GateKind::export_all(cfg)?;
    GateDecision::export_all(cfg)?;
    Ok(())
}

/// 一組要輸出成 TS 值陣列的列舉值，`ty` 是對應的 ts-rs 型別名稱。
struct ValueList {
    name: &'static str,
    ty: &'static str,
    values: Vec<&'static str>,
}

fn list<T: Copy>(
    name: &'static str,
    ty: &'static str,
    values: impl IntoIterator<Item = T>,
    as_str: fn(T) -> &'static str,
) -> ValueList {
    ValueList {
        name,
        ty,
        values: values.into_iter().map(as_str).collect(),
    }
}

/// 新增要給 TS 端使用的列舉時，在這裡加一行。
fn value_lists() -> Vec<ValueList> {
    vec![
        list(
            "RUN_STATUSES",
            "RunStatus",
            RunStatus::ALL.iter().copied(),
            RunStatus::as_str,
        ),
        list(
            "TERMINAL_RUN_STATUSES",
            "RunStatus",
            RunStatus::ALL.iter().copied().filter(|s| s.is_terminal()),
            RunStatus::as_str,
        ),
        list(
            "PERMISSION_POLICIES",
            "PermissionPolicy",
            PermissionPolicy::ALL.iter().copied(),
            PermissionPolicy::as_str,
        ),
        list(
            "DELEGATION_MODES",
            "DelegationMode",
            DelegationMode::ALL.iter().copied(),
            DelegationMode::as_str,
        ),
        list(
            "RUNNER_KINDS",
            "RunnerKind",
            RunnerKind::ALL.iter().copied(),
            RunnerKind::as_str,
        ),
        list(
            "GATE_KINDS",
            "GateKind",
            GateKind::ALL.iter().copied(),
            GateKind::as_str,
        ),
        list(
            "GATE_DECISIONS",
            "GateDecision",
            GateDecision::ALL.iter().copied(),
            GateDecision::as_str,
        ),
    ]
}

fn constants() -> String {
    let lists = value_lists();
    let mut out = String::from(HEADER);

    let mut types: Vec<&str> = lists.iter().map(|l| l.ty).collect();
    types.sort_unstable();
    types.dedup();
    for ty in types {
        writeln!(out, "import type {{ {ty} }} from \"./{ty}\";").unwrap();
    }

    writeln!(
        out,
        "\nexport const PROTOCOL_VERSION = {};",
        crate::PROTOCOL_VERSION
    )
    .unwrap();
    for l in &lists {
        let values: Vec<String> = l.values.iter().map(|v| format!("\"{v}\"")).collect();
        writeln!(
            out,
            "\nexport const {} = [{}] as const satisfies readonly {}[];",
            l.name,
            values.join(", "),
            l.ty
        )
        .unwrap();
    }
    out
}
