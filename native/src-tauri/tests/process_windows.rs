#![cfg(windows)]
use cratemind_native::process_tree::OwnedProcess;
use std::{io::Read, path::PathBuf, process::Command, time::Duration};

// Regression: a wrong PROC_THREAD_ATTRIBUTE_JOB_LIST value made every spawn fail with os error 24.
#[test]
fn spawns_child_in_job_with_piped_output() {
    let root = std::env::var_os("SystemRoot").expect("SystemRoot");
    let mut command = Command::new(PathBuf::from(root).join("System32").join("hostname.exe"));
    let mut child = OwnedProcess::spawn(&mut command).unwrap();
    let (_stdin, mut stdout, _stderr) = child.pipes();
    let mut output = String::new();
    stdout.read_to_string(&mut output).unwrap();
    assert!(!output.trim().is_empty());
    for _ in 0..500 {
        if let Some(code) = child.exited().unwrap() {
            assert_eq!(code, 0);
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("child did not exit");
}
