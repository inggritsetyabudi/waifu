use std::sync::Mutex;

/// Shared by all windows. Never serialize or log this state.
#[derive(Default)]
pub struct Credentials {
    cached: Mutex<Option<Result<Option<String>, String>>>,
}

impl Credentials {
    /// A status check must never unlock the credential file.
    pub fn is_ready(&self) -> bool {
        self.cached
            .try_lock()
            .map(|cached| matches!(&*cached, Some(Ok(Some(key))) if !key.is_empty()))
            .unwrap_or(false)
    }

    pub fn key(
        &self,
        explicit_retry: bool,
        read: impl FnOnce() -> Result<Option<String>, String>,
    ) -> Result<String, String> {
        // Serialize concurrent requests so main and companion cannot prompt twice.
        let mut cached = self.cached.lock().unwrap();
        if explicit_retry {
            *cached = None;
        }
        if cached.is_none() {
            *cached = Some(read().map(|key| key.filter(|value| !value.is_empty())));
        }
        cached.as_ref().unwrap().clone()?.ok_or_else(|| {
            "API key belum aktif. Buka Settings, lalu pilih Pakai sesi ini atau Muat .env.".into()
        })
    }

    pub fn set(
        &self,
        key: String,
        persist: bool,
        write: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut cached = self.cached.lock().unwrap();
        if persist {
            write(&key)?;
        }
        *cached = Some(Ok(if key.is_empty() { None } else { Some(key) }));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn one_store_read_for_concurrent_windows_and_many_messages() {
        let cache = Arc::new(Credentials::default());
        let reads = Arc::new(AtomicUsize::new(0));
        assert!(!cache.is_ready());
        std::thread::scope(|scope| {
            for _ in 0..12 {
                let (cache, reads) = (cache.clone(), reads.clone());
                scope.spawn(move || {
                    assert_eq!(
                        cache
                            .key(false, || {
                                reads.fetch_add(1, Ordering::SeqCst);
                                Ok(Some("test-key".into()))
                            })
                            .unwrap(),
                        "test-key"
                    );
                });
            }
        });
        assert!(cache.is_ready());
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        cache
            .key(false, || panic!("Chat must reuse cached key"))
            .unwrap();
        assert_eq!(
            cache
                .key(true, || Ok(Some("updated-from-env".into())))
                .unwrap(),
            "updated-from-env"
        );
    }

    #[test]
    fn denial_does_not_prompt_again_until_explicit_retry() {
        let cache = Credentials::default();
        assert!(cache.key(false, || Err("access denied".into())).is_err());
        assert!(
            cache
                .key(false, || panic!("Must not repeat denied access"))
                .is_err()
        );
        assert!(!cache.is_ready());
        cache.key(true, || Ok(Some("test-key".into()))).unwrap();
    }

    #[test]
    fn session_mode_never_touches_credential_file() {
        let cache = Credentials::default();
        cache
            .set("session-key".into(), false, |_| {
                panic!("Must not write to the credential file")
            })
            .unwrap();
        assert_eq!(
            cache
                .key(false, || panic!("Must not read the credential file"))
                .unwrap(),
            "session-key"
        );
        cache
            .set("replacement".into(), false, |_| unreachable!())
            .unwrap();
        assert_eq!(cache.key(false, || unreachable!()).unwrap(), "replacement");
    }
}
