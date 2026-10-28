#![cfg(unix)]
use cratemind_native::process_tree::OwnedProcess;
use std::{
    io::{BufRead, BufReader},
    process::Command,
    time::Duration,
};
#[test]
fn owned_group_terminates_and_reaps_direct_child() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "sleep 60 & echo $!; wait"]);
    let mut child = OwnedProcess::spawn(&mut command).unwrap();
    let (_stdin, stdout, _stderr) = child.pipes();
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).unwrap();
    let descendant: i32 = line.trim().parse().unwrap();
    child.terminate(Duration::from_millis(100));
    assert!(child.exited().unwrap().is_some());
    // The grandchild may briefly be an init-owned zombie, but cannot continue running.
    for _ in 0..100 {
        if unsafe { libc::kill(descendant, 0) } != 0 {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &descendant.to_string()])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&output.stdout)
        .trim()
        .starts_with('Z'));
}
