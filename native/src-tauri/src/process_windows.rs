//! Atomically assigns the child to its kill-on-close Job at process creation.
//! No suspended-process/AssignProcessToJobObject crash window is used.
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs::File,
    io,
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
    process::Command,
    ptr,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::SECURITY_ATTRIBUTES,
    System::{JobObjects::*, Pipes::CreatePipe, Threading::*},
};
struct Handle(HANDLE);
unsafe impl Send for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
fn pipe() -> io::Result<(Handle, Handle)> {
    let mut read = ptr::null_mut();
    let mut write = ptr::null_mut();
    let security = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    };
    if unsafe { CreatePipe(&mut read, &mut write, &security, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((Handle(read), Handle(write)))
}
fn quote(value: &OsStr) -> Vec<u16> {
    let mut output = vec![b'"' as u16];
    let mut slashes = 0;
    for c in value.encode_wide() {
        if c == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        output.extend(std::iter::repeat_n(
            b'\\' as u16,
            if c == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        slashes = 0;
        output.push(c);
    }
    output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    output.push(b'"' as u16);
    output
}
pub struct OwnedProcess {
    process: Handle,
    job: Handle,
    stdin: Option<File>,
    stdout: Option<File>,
    stderr: Option<File>,
}
impl OwnedProcess {
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        unsafe {
            let job = Handle(CreateJobObjectW(ptr::null(), ptr::null()));
            if job.0.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let (child_in, parent_in) = pipe()?;
            let (parent_out, child_out) = pipe()?;
            let (parent_err, child_err) = pipe()?;
            for handle in [&parent_in, &parent_out, &parent_err] {
                if SetHandleInformation(handle.0, HANDLE_FLAG_INHERIT, 0) == 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            let mut bytes = 0;
            InitializeProcThreadAttributeList(ptr::null_mut(), 2, 0, &mut bytes);
            let mut attributes = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
            let attribute_list = attributes.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
            if InitializeProcThreadAttributeList(attribute_list, 2, 0, &mut bytes) == 0 {
                return Err(io::Error::last_os_error());
            }
            struct Attributes(LPPROC_THREAD_ATTRIBUTE_LIST);
            impl Drop for Attributes {
                fn drop(&mut self) {
                    unsafe {
                        DeleteProcThreadAttributeList(self.0);
                    }
                }
            }
            let _attributes_guard = Attributes(attribute_list);
            let inherited = [child_in.0, child_out.0, child_err.0];
            let jobs = [job.0];
            // PROC_THREAD_ATTRIBUTE_JOB_LIST = ProcThreadAttributeValue(19, false, true, false).
            if UpdateProcThreadAttribute(
                attribute_list,
                0,
                0x00020013,
                jobs.as_ptr() as *const _,
                std::mem::size_of_val(&jobs),
                ptr::null_mut(),
                ptr::null(),
            ) == 0
                || UpdateProcThreadAttribute(
                    attribute_list,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    inherited.as_ptr() as *const _,
                    std::mem::size_of_val(&inherited),
                    ptr::null_mut(),
                    ptr::null(),
                ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let mut startup: STARTUPINFOEXW = std::mem::zeroed();
            startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = child_in.0;
            startup.StartupInfo.hStdOutput = child_out.0;
            startup.StartupInfo.hStdError = child_err.0;
            startup.lpAttributeList = attribute_list;
            let executable = wide(command.get_program());
            let mut arguments = quote(command.get_program());
            for arg in command.get_args() {
                arguments.push(b' ' as u16);
                arguments.extend(quote(arg));
            }
            arguments.push(0);
            let directory = command.get_current_dir().map(|d| wide(d.as_os_str()));
            let mut environment: BTreeMap<_, _> = std::env::vars_os().collect();
            for (key, value) in command.get_envs() {
                if let Some(value) = value {
                    environment.insert(key.to_owned(), value.to_owned());
                } else {
                    environment.remove(key);
                }
            }
            let mut environment_block = Vec::new();
            for (key, value) in environment {
                environment_block.extend(key.encode_wide());
                environment_block.push(b'=' as u16);
                environment_block.extend(value.encode_wide());
                environment_block.push(0);
            }
            environment_block.push(0);
            let mut information: PROCESS_INFORMATION = std::mem::zeroed();
            if CreateProcessW(
                executable.as_ptr(),
                arguments.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                1,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                environment_block.as_ptr() as *const _,
                directory.as_ref().map_or(ptr::null(), |d| d.as_ptr()),
                &startup.StartupInfo,
                &mut information,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let process = Handle(information.hProcess);
            let _thread = Handle(information.hThread);
            let to_file = |handle: Handle| {
                let raw = handle.0;
                std::mem::forget(handle);
                File::from_raw_handle(raw)
            };
            Ok(Self {
                process,
                job,
                stdin: Some(to_file(parent_in)),
                stdout: Some(to_file(parent_out)),
                stderr: Some(to_file(parent_err)),
            })
        }
    }
    pub fn pipes(&mut self) -> (File, File, File) {
        (
            self.stdin.take().unwrap(),
            self.stdout.take().unwrap(),
            self.stderr.take().unwrap(),
        )
    }
    pub fn exited(&mut self) -> io::Result<Option<i32>> {
        unsafe {
            if WaitForSingleObject(self.process.0, 0) == WAIT_OBJECT_0 {
                let mut code = 0;
                if GetExitCodeProcess(self.process.0, &mut code) == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Some(code as i32))
            } else {
                Ok(None)
            }
        }
    }
    pub fn terminate(&mut self, _grace: Duration) {
        unsafe {
            TerminateJobObject(self.job.0, 1);
            WaitForSingleObject(self.process.0, 1000);
        }
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.terminate(Duration::ZERO);
    }
}
