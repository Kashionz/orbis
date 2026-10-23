//! 這台 Runner 上的 Preview（§13）：
//! - 正在執行的 dev server 的 port，relay 只轉送給登記在這裡的 Run。
//! - 重新啟動的把手（`restart_preview`），在設定了 Preview 的 Run 的整個生命週期都有效。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use orbis_protocol::ids::RunId;
use tokio::sync::mpsc;

#[derive(Debug, Default)]
pub struct PreviewRegistry {
    ports: Mutex<HashMap<RunId, u16>>,
    restarts: Mutex<HashMap<RunId, mpsc::UnboundedSender<()>>>,
}

impl PreviewRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 這個 Run 的 dev server 正在執行時回傳它的 port。
    pub fn port(&self, run_id: &RunId) -> Option<u16> {
        self.lock().get(run_id).copied()
    }

    /// 要求重新啟動這個 Run 的 dev server；這個 Run 沒有設定 Preview 時回傳 false。
    pub fn restart(&self, run_id: &RunId) -> bool {
        lock(&self.restarts)
            .get(run_id)
            .is_some_and(|tx| tx.send(()).is_ok())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<RunId, u16>> {
        lock(&self.ports)
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// 登記的權利：dev server 啟動後呼叫 [`Registration::register`]，回傳的 guard drop 時取消登記。
#[derive(Debug, Clone)]
pub struct Registration {
    pub registry: Arc<PreviewRegistry>,
    pub run_id: RunId,
}

impl Registration {
    /// 登記重新啟動的把手；回傳的 guard drop 時取消登記。
    pub fn control(self, restart: mpsc::UnboundedSender<()>) -> ControlGuard {
        lock(&self.registry.restarts).insert(self.run_id.clone(), restart);
        ControlGuard { registration: self }
    }

    pub fn register(self, port: u16) -> RegistrationGuard {
        self.registry.lock().insert(self.run_id.clone(), port);
        RegistrationGuard {
            registration: self,
            port,
        }
    }
}

#[derive(Debug)]
pub struct RegistrationGuard {
    registration: Registration,
    port: u16,
}

impl Drop for RegistrationGuard {
    fn drop(&mut self) {
        let mut ports = self.registration.registry.lock();
        // 重新啟動時新的程序可能已經登記了，只移除自己的
        if ports.get(&self.registration.run_id) == Some(&self.port) {
            ports.remove(&self.registration.run_id);
        }
    }
}

#[derive(Debug)]
pub struct ControlGuard {
    registration: Registration,
}

impl Drop for ControlGuard {
    fn drop(&mut self) {
        lock(&self.registration.registry.restarts).remove(&self.registration.run_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_drop_時取消登記() {
        let registry = PreviewRegistry::new();
        let run: RunId = "r1".into();
        let guard = Registration {
            registry: registry.clone(),
            run_id: run.clone(),
        }
        .register(4100);
        assert_eq!(registry.port(&run), Some(4100));
        drop(guard);
        assert_eq!(registry.port(&run), None);
    }
}
