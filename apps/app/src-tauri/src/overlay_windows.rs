//! Windows overlay operations stay on the owning UI thread and never activate it.
use std::{ffi::c_void, io, sync::mpsc, time::Duration};
use tauri::WebviewWindow;

type Hwnd = *mut c_void;
type SubclassProc = unsafe extern "system" fn(Hwnd, u32, usize, isize, usize, usize) -> isize;
const SUBCLASS_ID: usize = 0x574d4f56;
const GWL_EXSTYLE: i32 = -20;
const WS_EX_NOACTIVATE: u32 = 0x08000000;
const SWP_NOACTIVATE: u32 = 0x10;

#[repr(C)]
struct StyleStruct {
    old: u32,
    new: u32,
}

#[link(name = "user32")]
extern "system" {
    fn GetWindowLongPtrW(hwnd: Hwnd, index: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: Hwnd, index: i32, value: isize) -> isize;
    fn GetWindowThreadProcessId(hwnd: Hwnd, process: *mut u32) -> u32;
    fn SetWindowPos(
        hwnd: Hwnd,
        after: Hwnd,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        flags: u32,
    ) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentThreadId() -> u32;
}
#[link(name = "comctl32")]
extern "system" {
    fn SetWindowSubclass(hwnd: Hwnd, callback: SubclassProc, id: usize, data: usize) -> i32;
    fn RemoveWindowSubclass(hwnd: Hwnd, callback: SubclassProc, id: usize) -> i32;
    fn DefSubclassProc(hwnd: Hwnd, message: u32, wparam: usize, lparam: isize) -> isize;
}

unsafe extern "system" fn non_activating_proc(
    hwnd: Hwnd,
    message: u32,
    wparam: usize,
    lparam: isize,
    id: usize,
    data: usize,
) -> isize {
    match message {
        0x0021 => return 3, // WM_MOUSEACTIVATE -> MA_NOACTIVATE (deliver the mouse event).
        0x007c if data == 1 && wparam as i32 == GWL_EXSTYLE && lparam != 0 => {
            // Framework style updates must not erase the overlay's activation policy.
            (*(lparam as *mut StyleStruct)).new |= WS_EX_NOACTIVATE;
        }
        0x0082 => {
            RemoveWindowSubclass(hwnd, non_activating_proc, id);
        } // WM_NCDESTROY
        _ => {}
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

fn on_ui_thread(
    window: &WebviewWindow,
    operation: impl FnOnce(Hwnd) -> io::Result<()> + Send + 'static,
) -> tauri::Result<()> {
    let handle = window.hwnd()?.0 as usize;
    if unsafe {
        GetWindowThreadProcessId(handle as Hwnd, std::ptr::null_mut()) == GetCurrentThreadId()
    } {
        return operation(handle as Hwnd).map_err(Into::into);
    }
    let (sender, receiver) = mpsc::channel();
    window.run_on_main_thread(move || {
        let _ = sender.send(operation(handle as Hwnd));
    })?;
    receiver
        .recv_timeout(Duration::from_secs(3))
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Overlay UI thread did not respond"))?
        .map_err(Into::into)
}

unsafe fn configure(hwnd: Hwnd) -> io::Result<()> {
    if SetWindowSubclass(hwnd, non_activating_proc, SUBCLASS_ID, 1) == 0 {
        return Err(io::Error::last_os_error());
    }
    let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_NOACTIVATE as isize);
    Ok(())
}

pub fn show(window: &WebviewWindow) -> tauri::Result<()> {
    on_ui_thread(window, |hwnd| unsafe {
        configure(hwnd)?;
        // Reassert topmost on every show; don't depend on stale framework visibility flags.
        if SetWindowPos(
            hwnd,
            -1isize as Hwnd,
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | 0x01 | 0x02 | 0x20 | 0x40,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })
}

pub fn hide(window: &WebviewWindow) -> tauri::Result<()> {
    on_ui_thread(window, |hwnd| unsafe {
        if SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | 0x01 | 0x02 | 0x04 | 0x80,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })
}
