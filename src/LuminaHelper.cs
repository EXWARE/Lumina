using System;
using System.Runtime.InteropServices;
using System.Text;

class LuminaHelper {
    [DllImport("user32.dll")]
    static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

    [DllImport("user32.dll")]
    static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    [DllImport("user32.dll")]
    static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint crKey, byte bAlpha, uint dwFlags);

    [DllImport("user32.dll")]
    static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool EnumChildWindows(IntPtr hwndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WindowCompositionAttributeData {
        public int Attribute;
        public IntPtr Data;
        public int SizeOfData;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct AccentPolicy {
        public int AccentState;
        public int AccentFlags;
        public uint GradientColor;
        public int AnimationId;
    }

    const int SM_CXSCREEN = 0;
    const int SM_CYSCREEN = 1;
    const int SM_XVIRTUALSCREEN = 76;
    const int SM_YVIRTUALSCREEN = 77;
    const int SM_CXVIRTUALSCREEN = 78;
    const int SM_CYVIRTUALSCREEN = 79;
    const uint SWP_SHOWWINDOW = 0x0040;
    const uint SWP_NOACTIVATE = 0x0010;

    static volatile int currentThemeState = 0; // 0 = none, 2 = clear, 3 = blur, 4 = fluent
    static volatile uint currentThemeColor = 0x00FFFFFF;
    static volatile bool shouldExit = false;

    static void Main(string[] args) {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.InputEncoding = System.Text.Encoding.UTF8;
        if (args.Length < 1) {
            Console.WriteLine("Usage: LuminaHelper <WindowTitleOrHwnd> [autopause|normal] [themeState] [themeColor]");
            return;
        }
        string targetTitle = args[0];
        bool enableAutoPause = args.Length > 1 && args[1] == "autopause";
        
        if (args.Length > 2) {
            int.TryParse(args[2], out currentThemeState);
        }
        if (args.Length > 3) {
            uint.TryParse(args[3], out currentThemeColor);
        }

        // 1. Find Progman window with fallback
        IntPtr progman = FindWindow("Progman", null);
        if (progman == IntPtr.Zero) {
            progman = FindWindowEx(IntPtr.Zero, IntPtr.Zero, "Progman", null);
        }
        int pRetry = 0;
        while (progman == IntPtr.Zero && pRetry < 5) {
            System.Threading.Thread.Sleep(100);
            progman = FindWindow("Progman", null);
            if (progman == IntPtr.Zero) progman = FindWindowEx(IntPtr.Zero, IntPtr.Zero, "Progman", null);
            pRetry++;
        }

        IntPtr workerw = IntPtr.Zero;
        if (progman != IntPtr.Zero) {
            // 2. Trigger the creation of WorkerW window
            IntPtr result;
            SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, 0x0000, 1000, out result);
            int wRetry = 0;
            while (workerw == IntPtr.Zero && wRetry < 10) {
                workerw = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
                if (workerw == IntPtr.Zero) {
                    System.Threading.Thread.Sleep(50);
                }
                wRetry++;
            }
        }
        if (workerw == IntPtr.Zero) {
            // Check for sibling of the window containing SHELLDLL_DefView
            EnumWindowsProc findWorkerW1 = (hwnd, lParam) => {
                IntPtr shell = FindWindowEx(hwnd, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (shell != IntPtr.Zero) {
                    workerw = FindWindowEx(IntPtr.Zero, hwnd, "WorkerW", null);
                }
                return true;
            };
            EnumWindows(findWorkerW1, IntPtr.Zero);
            GC.KeepAlive(findWorkerW1);
        }

        // Fallback: search for any WorkerW window that does NOT contain the icons view
        if (workerw == IntPtr.Zero) {
            EnumWindowsProc findWorkerW2 = (hwnd, lParam) => {
                StringBuilder className = new StringBuilder(256);
                GetClassName(hwnd, className, className.Capacity);
                if (className.ToString() == "WorkerW") {
                    IntPtr shell = FindWindowEx(hwnd, IntPtr.Zero, "SHELLDLL_DefView", null);
                    if (shell == IntPtr.Zero) {
                        workerw = hwnd;
                    }
                }
                return true;
            };
            EnumWindows(findWorkerW2, IntPtr.Zero);
            GC.KeepAlive(findWorkerW2);
        }

        // Final fallback: use progman if WorkerW is not spawned
        if (workerw == IntPtr.Zero) {
            workerw = progman;
        }

        if (workerw == IntPtr.Zero) {
            Console.WriteLine("Error: Could not find WorkerW or Progman window.");
            return;
        }

        // 4. Find our target wallpaper window (supports direct HWND integer or window title fallback)
        IntPtr targetHwnd = IntPtr.Zero;
        long hwndVal;
        if (long.TryParse(targetTitle, out hwndVal)) {
            targetHwnd = new IntPtr(hwndVal);
            Console.WriteLine("Using direct HWND: " + targetHwnd);
        } else {
            targetHwnd = FindWindow(null, targetTitle);
            int retryCount = 0;
            while (targetHwnd == IntPtr.Zero && retryCount < 10) {
                System.Threading.Thread.Sleep(200);
                targetHwnd = FindWindow(null, targetTitle);
                retryCount++;
            }
        }

        if (targetHwnd == IntPtr.Zero) {
            Console.WriteLine("Error: Could not find target window: " + targetTitle);
            return;
        }

        // 5. Set our wallpaper window as a child of WorkerW
        SetParent(targetHwnd, workerw);

        // 6. Resize the window to cover the screen
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        int height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if (width == 0) width = GetSystemMetrics(SM_CXSCREEN);
        if (height == 0) height = GetSystemMetrics(SM_CYSCREEN);
        SetWindowPos(targetHwnd, IntPtr.Zero, vx, vy, width, height, SWP_SHOWWINDOW | SWP_NOACTIVATE);

        Console.WriteLine("Successfully parented window.");
        Console.Out.Flush();

        // 7. Stdin Command thread
        System.Threading.Thread commandThread = new System.Threading.Thread(() => {
            string line;
            while ((line = Console.ReadLine()) != null) {
                try {
                    if (line.StartsWith("TASKBAR:")) {
                        string[] parts = line.Substring(8).Split(',');
                        if (parts.Length > 0) {
                            int.TryParse(parts[0], out currentThemeState);
                        }
                        if (parts.Length > 1) {
                            uint.TryParse(parts[1], out currentThemeColor);
                        }
                        ApplyTaskbarTheme(currentThemeState, currentThemeColor);
                    }
                } catch (Exception ex) {
                    Console.WriteLine("Error parsing stdin command: " + ex.Message);
                }
            }
            shouldExit = true;
        });
        commandThread.IsBackground = true;
        commandThread.Start();

        // Apply initial theme immediately
        ApplyTaskbarTheme(currentThemeState, currentThemeColor);

        // 8. Main Loop (Runs Autopause & Keep-Alive Theme Lock)
        bool isPaused = false;
        StringBuilder focusedClass = new StringBuilder(256);

        while (!shouldExit) {
            System.Threading.Thread.Sleep(1000);

            // Periodically enforce taskbar style (skip if no theme applied)
            if (currentThemeState != 0) {
                ApplyTaskbarTheme(currentThemeState, currentThemeColor);
            }

            if (enableAutoPause) {
                IntPtr fg = GetForegroundWindow();
                if (fg == IntPtr.Zero || fg == targetHwnd || fg == workerw || fg == progman) {
                    if (isPaused) {
                        Console.WriteLine("RESUME");
                        Console.Out.Flush();
                        isPaused = false;
                    }
                    continue;
                }

                focusedClass.Clear();
                GetClassName(fg, focusedClass, focusedClass.Capacity);
                string cls = focusedClass.ToString();
                if (cls == "WorkerW" || cls == "Progman" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") {
                    if (isPaused) {
                        Console.WriteLine("RESUME");
                        Console.Out.Flush();
                        isPaused = false;
                    }
                    continue;
                }

                RECT rect;
                if (GetWindowRect(fg, out rect)) {
                    bool coversScreen = rect.Left <= 0 && rect.Top <= 0 && rect.Right >= width && rect.Bottom >= height;
                    if (coversScreen) {
                        if (!isPaused) {
                            Console.WriteLine("PAUSE");
                            Console.Out.Flush();
                            isPaused = true;
                        }
                    } else {
                        if (isPaused) {
                            Console.WriteLine("RESUME");
                            Console.Out.Flush();
                            isPaused = false;
                        }
                    }
                }
            }
        }

        // Reset taskbar to default when exiting
        if (currentThemeState != 0) {
            ApplyTaskbarTheme(0, 0);
        }
    }

    static void ApplyTaskbarTheme(int themeState, uint color) {
        IntPtr taskbar = FindWindow("Shell_TrayWnd", null);
        if (taskbar != IntPtr.Zero) {
            ApplyAccent(taskbar, themeState, color);
        }
        
        IntPtr secTaskbar = FindWindow("Shell_SecondaryTrayWnd", null);
        while (secTaskbar != IntPtr.Zero) {
            ApplyAccent(secTaskbar, themeState, color);
            secTaskbar = FindWindowEx(IntPtr.Zero, secTaskbar, "Shell_SecondaryTrayWnd", null);
        }
    }

    static void ApplyAccent(IntPtr hwnd, int themeState, uint color) {
        if (hwnd == IntPtr.Zero) return;
        
        // Clear Windows 11 system backdrop fill (DWMWA_SYSTEMBACKDROP_TYPE = 38, DWMSBT_NONE = 1)
        int backdropType = (themeState == 0) ? 0 : 1;
        try {
            DwmSetWindowAttribute(hwnd, 38, ref backdropType, sizeof(int));
        } catch {}

        AccentPolicy policy = new AccentPolicy();
        policy.AccentState = themeState;
        policy.AccentFlags = (themeState == 0) ? 0 : 2; // draw color
        policy.GradientColor = color; // AABBGGRR

        int size = Marshal.SizeOf(policy);
        IntPtr policyPtr = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(policy, policyPtr, false);
            WindowCompositionAttributeData data = new WindowCompositionAttributeData();
            data.Attribute = 19; // WCA_ACCENT_POLICY
            data.SizeOfData = size;
            data.Data = policyPtr;
            SetWindowCompositionAttribute(hwnd, ref data);
        } catch (EntryPointNotFoundException) {
            // Expected on unsupported Windows versions
        } catch (Exception ex) {
            Console.WriteLine("Warning: ApplyAccent failed: " + ex.GetType().Name + ": " + ex.Message);
        } finally {
            Marshal.FreeHGlobal(policyPtr);
        }

        // Target Windows 11 XAML CoreWindow / TaskbarFrame children if present
        IntPtr coreWin = FindWindowEx(hwnd, IntPtr.Zero, "Windows.UI.Core.CoreWindow", null);
        if (coreWin != IntPtr.Zero) {
            try {
                DwmSetWindowAttribute(coreWin, 38, ref backdropType, sizeof(int));
            } catch {}
        }
    }
}
