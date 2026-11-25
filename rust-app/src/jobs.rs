//! Cooperative, versioned optimization jobs with a single-slot latest preview.
use crate::{
    engine::{self, Progress, SearchContext},
    model::Plan,
};
use serde_json::Value;
use std::{
    fmt,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobError {
    Cancelled,
    TimedOut,
    Failed(String),
}
impl fmt::Display for JobError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => write!(f, "已停止优化"),
            Self::TimedOut => write!(
                f,
                "优化超过60秒，已停止。请尝试快速模式或减少零件数量后重试"
            ),
            Self::Failed(e) => write!(f, "{e}"),
        }
    }
}

pub struct OptimizationJob {
    pub generation: u64,
    cancelled: Arc<AtomicBool>,
    latest: Arc<Mutex<Option<Progress>>>,
    completion: Receiver<std::result::Result<Plan, JobError>>,
    thread: Option<JoinHandle<()>>,
}
impl OptimizationJob {
    pub fn start(generation: u64, project: Value, timeout: Duration) -> Result<Self, String> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let latest = Arc::new(Mutex::new(None));
        let (sender, completion) = mpsc::sync_channel(1);
        let cancel = cancelled.clone();
        let preview = latest.clone();
        let thread = thread::Builder::new()
            .name(format!("cutting-{generation}"))
            .spawn(move || {
                let started = Instant::now();
                let checkpoint = || {
                    if cancel.load(Ordering::Relaxed) {
                        Err("__cancelled".into())
                    } else if started.elapsed() >= timeout {
                        Err("__timeout".into())
                    } else {
                        Ok(())
                    }
                };
                let mut progress = |value| {
                    if !cancel.load(Ordering::Relaxed) {
                        *preview.lock().unwrap_or_else(|e| e.into_inner()) = Some(value);
                    }
                };
                let mut context = SearchContext::new(&checkpoint, &mut progress);
                context.progress_interval = Duration::from_millis(50);
                let outcome = catch_unwind(AssertUnwindSafe(|| {
                    engine::optimize_with_context(&project, true, &mut context)
                }));
                let result = if cancel.load(Ordering::Relaxed) {
                    Err(JobError::Cancelled)
                } else if started.elapsed() >= timeout {
                    Err(JobError::TimedOut)
                } else {
                    match outcome {
                        Ok(Ok(plan)) => Ok(plan),
                        Ok(Err(error)) => Err(match error.as_str() {
                            "__cancelled" => JobError::Cancelled,
                            "__timeout" => JobError::TimedOut,
                            _ => JobError::Failed(error),
                        }),
                        Err(_) => Err(JobError::Failed(
                            "优化计算异常，请减少零件数量或使用快速模式后重试".into(),
                        )),
                    }
                };
                // Completion has its own bounded channel and cannot be lost behind previews.
                let _ = sender.send(result);
            })
            .map_err(|e| format!("无法启动优化线程：{e}"))?;
        Ok(Self {
            generation,
            cancelled,
            latest,
            completion,
            thread: Some(thread),
        })
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        *self.latest.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    pub fn progress(&self, current_generation: u64) -> Option<Progress> {
        if self.generation != current_generation {
            self.cancel();
            return None;
        }
        self.latest.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
    pub fn poll(&mut self, current_generation: u64) -> Option<Result<Plan, JobError>> {
        if self.generation != current_generation {
            self.cancel();
            return None;
        }
        match self.completion.try_recv() {
            Ok(result) => {
                if self.thread.as_ref().is_some_and(|t| t.is_finished()) {
                    let _ = self.thread.take().unwrap().join();
                }
                Some(if self.cancelled.load(Ordering::Relaxed) {
                    Err(JobError::Cancelled)
                } else {
                    result
                })
            }
            Err(mpsc::TryRecvError::Empty) => None,
            Err(mpsc::TryRecvError::Disconnected) => {
                Some(Err(JobError::Failed("优化线程已异常退出".into())))
            }
        }
    }
    pub fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(|t| t.is_finished())
    }
}
impl Drop for OptimizationJob {
    fn drop(&mut self) {
        self.cancel(); /* detach: never block the UI waiting for cancellation */
    }
}
