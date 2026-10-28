//! Child ownership is established before Python starts executing.
#[cfg(unix)]
mod platform {
    use std::{
        io,
        os::unix::process::CommandExt,
        process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
        time::{Duration, Instant},
    };
    pub struct OwnedProcess {
        child: Child,
        pgid: i32,
    }
    impl OwnedProcess {
        pub fn spawn(command: &mut Command) -> io::Result<Self> {
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .process_group(0);
            let child = command.spawn()?;
            let pgid = child.id() as i32;
            Ok(Self { child, pgid })
        }
        pub fn pipes(&mut self) -> (ChildStdin, ChildStdout, ChildStderr) {
            (
                self.child.stdin.take().unwrap(),
                self.child.stdout.take().unwrap(),
                self.child.stderr.take().unwrap(),
            )
        }
        pub fn exited(&mut self) -> io::Result<Option<i32>> {
            Ok(self.child.try_wait()?.map(|s| s.code().unwrap_or(-1)))
        }
        pub fn terminate(&mut self, grace: Duration) {
            if self.pgid <= 1 {
                return;
            }
            unsafe {
                libc::kill(-self.pgid, libc::SIGTERM);
            }
            let deadline = Instant::now() + grace;
            while Instant::now() < deadline {
                if self.exited().ok().flatten().is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            // Even an exited Python may leave tool descendants in its owned process group.
            unsafe {
                libc::kill(-self.pgid, libc::SIGKILL);
            }
            let _ = self.child.wait();
            self.pgid = 0;
        }
    }
    impl Drop for OwnedProcess {
        fn drop(&mut self) {
            self.terminate(Duration::ZERO);
        }
    }
}
#[cfg(windows)]
#[path = "process_windows.rs"]
mod platform;
pub use platform::OwnedProcess;
