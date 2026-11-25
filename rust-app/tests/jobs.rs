use board_cut_optimizer::jobs::{JobError, OptimizationJob};
use serde_json::{Value, json};
use std::{
    thread,
    time::{Duration, Instant},
};
fn project(quantity: u64) -> Value {
    json!({"panels":[{"id":"panel","length":1000,"width":1000,"thickness":18}],"parts":[{"id":"part","length":100,"width":100,"thickness":18,"quantity":quantity}],"settings":{"optimizationLevel":"quick","sawWidth":0,"panelMarginX":0,"panelMarginY":0}})
}
fn wait(job: &mut OptimizationJob) -> Result<board_cut_optimizer::model::Plan, JobError> {
    let start = Instant::now();
    loop {
        if let Some(result) = job.poll(job.generation) {
            return result;
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "job did not terminate cooperatively"
        );
        thread::sleep(Duration::from_millis(2));
    }
}
#[test]
fn completion_and_cancelled_restart() {
    let mut job = OptimizationJob::start(1, project(1), Duration::from_secs(3)).unwrap();
    assert_eq!(wait(&mut job).unwrap().stats["placedCount"], 1);
    let mut job = OptimizationJob::start(2, project(1_000_000), Duration::from_secs(3)).unwrap();
    job.cancel();
    assert_eq!(wait(&mut job).unwrap_err(), JobError::Cancelled);
    let mut next = OptimizationJob::start(3, project(2), Duration::from_secs(3)).unwrap();
    assert_eq!(wait(&mut next).unwrap().stats["placedCount"], 2);
}
#[test]
fn timeout_interrupts_expansion_and_search() {
    let mut job = OptimizationJob::start(1, project(1_000_000), Duration::from_millis(2)).unwrap();
    assert_eq!(wait(&mut job).unwrap_err(), JobError::TimedOut);
    let mut job = OptimizationJob::start(2, project(1), Duration::ZERO).unwrap();
    assert_eq!(wait(&mut job).unwrap_err(), JobError::TimedOut);
}
#[test]
fn progress_is_available_without_waiting_for_completion() {
    let mut job = OptimizationJob::start(1, project(300), Duration::from_secs(3)).unwrap();
    let start = Instant::now();
    loop {
        if let Some(progress) = job.progress(1) {
            assert_eq!(progress.total_count, 300);
            assert!(!progress.layouts.is_empty());
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(2));
        thread::sleep(Duration::from_millis(2));
    }
    job.cancel();
    assert_eq!(wait(&mut job).unwrap_err(), JobError::Cancelled);
}
#[test]
fn stale_generation_never_publishes_progress_or_results() {
    let mut job = OptimizationJob::start(7, project(300), Duration::from_secs(3)).unwrap();
    assert!(job.progress(8).is_none());
    assert!(job.poll(8).is_none());
    let start = Instant::now();
    while !job.is_finished() {
        assert!(start.elapsed() < Duration::from_secs(2));
        thread::sleep(Duration::from_millis(2));
    }
    assert!(job.progress(8).is_none());
    assert!(job.poll(8).is_none());
}
#[test]
fn cancellation_wins_over_unconsumed_completed_result() {
    let mut job = OptimizationJob::start(1, project(1), Duration::from_secs(3)).unwrap();
    let start = Instant::now();
    while !job.is_finished() {
        assert!(start.elapsed() < Duration::from_secs(2));
        thread::sleep(Duration::from_millis(2));
    }
    job.cancel();
    assert_eq!(wait(&mut job).unwrap_err(), JobError::Cancelled);
}
