//! 正在執行的 Preview：Run → dev server 的 port。relay 只轉送給登記在這裡的 Run（§13）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use orbis_protocol::ids::RunId;

#[derive(Debug, Default)]
pub struct PreviewRegistry {
    ports: Mutex<HashMap<RunId, u16>>,
}

impl PreviewRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 這個 Run 的 dev server 正在執行時回傳它的 port。
    pub fn port(&self, run_id: &RunId) -> Option<u16> {
        self.lock().get(run_id).copied()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<RunId, u16>> {
        self.ports
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// 登記的權利：dev server 啟動後呼叫 [`Registration::register`]，回傳的 guard drop 時取消登記。
#[derive(Debug, Clone)]
pub struct Registration {
    pub registry: Arc<PreviewRegistry>,
    pub run_id: RunId,
}

impl Registration {
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
