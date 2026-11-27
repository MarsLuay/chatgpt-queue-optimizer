# Install through the real Chromium UI. No preference edits, debugging port,
# security bypass, or browser termination. Adapted from pi-vault/scripts/install-chromium-extension.ps1.
param([ValidateSet('Chromium','Google Chrome')][string]$ProductName='Chromium',[string]$BrowserPath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = 'validate extension and discover Chromium'
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $children = [System.Windows.Automation.TreeScope]::Children
    $descendants = [System.Windows.Automation.TreeScope]::Descendants
    $any = [System.Windows.Automation.Condition]::TrueCondition
    $repo=Split-Path -Parent $PSScriptRoot
    $source=Join-Path $repo 'build\chrome-src'
    $source=(Resolve-Path -LiteralPath $source).ProviderPath
    $manifest=Get-Content -LiteralPath (Join-Path $source 'manifest.json') -Raw | ConvertFrom-Json
    $expected=Get-Content -LiteralPath (Join-Path $repo 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.name -cne 'ChatGPT Queue + Optimizer' -or $manifest.manifest_version -ne 3 -or $manifest.version -cne $expected.version) { throw 'Generated Chromium manifest does not match the current checkout.' }
    # Dedicated public development key, never used in the store package.
    $publicKey='MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0cV7LPS/vHIVWJGrcghAd2TIgknmbP4Xdq+INlbS8W638gPxBGtZRe0pyh8op8zzg0JrtctPBk7+AKZEg/5Iaa3J8xzh10uWiPUg3w4cqS3FlKeDfCYTzXzUtY3BgX4XlUKy+D8lSBioarW02Q+tY8+TdVB3B0BE7mNIswKCkiKwKSA/2DlkboEE7BdhWnFu8C8XBI7u+uco2xDgvaGdUCn28MEwfI8lxgkTIW6+Sn99pKS4wDQEMKlCGpRevxAg3mD5MBYZoA2C2v8vDfCBNw+4TvlrWuKUb7X5cg0PME1SDq03lWqHxJgXYDm5XHrn6dNO7Wbc4MlstG0XzqxlyQIDAQAB'
    $manifest | Add-Member -NotePropertyName key -NotePropertyValue $publicKey -Force
    $key=[Convert]::FromBase64String($publicKey)
    $sha=[Security.Cryptography.SHA256]::Create()
    try { $digest=$sha.ComputeHash($key) } finally { $sha.Dispose() }
    $id=-join ($digest[0..15] | ForEach-Object { [char](97+($_ -shr 4)); [char](97+($_ -band 15)) })
    $product=$ProductName
    function Is-Chromium([string]$path) {
        if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
        return [Diagnostics.FileVersionInfo]::GetVersionInfo($path).ProductName -ceq $product
    }
    $candidates = @()
    foreach ($p in @(Get-Process -Name chrome,chromium -ErrorAction SilentlyContinue)) {
        try { if ($p.Path) { $candidates += $p.Path } } catch {}
    }
    foreach ($registry in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths','HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')) {
        foreach ($name in @('chromium.exe','chrome.exe')) {
            $entry = Get-Item -LiteralPath (Join-Path $registry $name) -ErrorAction SilentlyContinue
            if ($entry) { $candidates += [string]$entry.GetValue('') }
        }
    }
    foreach ($base in @($env:LOCALAPPDATA,$env:ProgramFiles,[Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))) {
        if ($base) {
            if ($product -eq 'Google Chrome') {
                foreach ($channel in @('Chrome','Chrome Beta','Chrome Dev','Chrome SxS')) {
                    $candidates += (Join-Path $base ("Google\"+$channel+"\Application\chrome.exe"))
                }
            } else {
                $candidates += (Join-Path $base 'Chromium\Application\chrome.exe')
                $candidates += (Join-Path $base 'Chromium\Application\chromium.exe')
            }
        }
    }
    foreach ($name in @('chromium.exe','chrome.exe')) {
        $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { $candidates += $command.Source }
    }
    if ($BrowserPath) {
        if (-not (Is-Chromium $BrowserPath)) { throw 'Explicit browser executable does not match the requested product.' }
        $browser=$BrowserPath
    } else {
        $browser=$candidates | Where-Object { Is-Chromium $_ } | Select-Object -First 1
        if (-not $browser) { Write-Output "$product executable not found."; exit 2 }
    }
    $browser = (Resolve-Path -LiteralPath $browser).ProviderPath
    $version=[string]$manifest.version
    if (-not $version) { throw 'Prepared extension has no version.' }

    # Keep a stable unpacked directory separate from the transient store build.
    # Update files individually via same-volume replacement; manifest last.
    $stage='prepare persistent local Chromium source'
    $extension=Join-Path $repo 'build\local-chromium\extension'
    New-Item -ItemType Directory -Path $extension -Force | Out-Null
    $extension=(Resolve-Path -LiteralPath $extension).ProviderPath
    function Write-LocalFile([string]$destination,[string]$sourceFile,[string]$text) {
        $parent=Split-Path -Parent $destination
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        $temp=Join-Path $parent ([Guid]::NewGuid().ToString()+'.tmp')
        try {
            if ($sourceFile) { [IO.File]::Copy($sourceFile,$temp) }
            else { [IO.File]::WriteAllText($temp,$text,[Text.UTF8Encoding]::new($false)) }
            if ([IO.File]::Exists($destination)) { [IO.File]::Replace($temp,$destination,$null) }
            else { [IO.File]::Move($temp,$destination) }
        } finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
    }
    foreach ($file in (Get-ChildItem -LiteralPath $source -Recurse -File)) {
        $relative=$file.FullName.Substring($source.Length+1)
        if ($relative -eq 'manifest.json') { continue }
        Write-LocalFile (Join-Path $extension $relative) $file.FullName ''
    }
    Write-LocalFile (Join-Path $extension 'manifest.json') '' ($manifest | ConvertTo-Json -Depth 30)
    Write-Output "Local $product extension ID: $id"

    # Enumerate actual top-level HWNDs independently of the accessibility
    # provider. Some Chromium versions do not expose the browser window as a
    # desktop UIA child until accessibility is requested for that HWND.
    Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','Accessibility.dll') -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class QueueOptimizerChromiumWindows {
    private delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    public static void Restore(IntPtr hwnd) {
        if (IsIconic(hwnd)) ShowWindowAsync(hwnd, 9);
    }
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int capacity);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hwnd, int id);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, string text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    public static IntPtr[] OwnedDialogs(IntPtr owner) {
        var result = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
            if (!IsWindowVisible(hwnd)) return true;
            var name = new StringBuilder(128);
            GetClassName(hwnd, name, name.Capacity);
            if (name.ToString() != "#32770") return true;
            IntPtr current = GetWindow(hwnd, 4); // GW_OWNER
            for (int depth = 0; current != IntPtr.Zero && depth < 16; depth++) {
                if (current == owner) { result.Add(hwnd); break; }
                current = GetWindow(current, 4);
            }
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
    // Chromium's confirmation bubble is a Views widget, not a #32770 dialog.
    // Enumerate owned widgets as well as classic dialogs, restricting them to
    // the same browser process and owner chain.
    public static IntPtr[] OwnedWidgets(IntPtr owner) {
        var result = new List<IntPtr>();
        uint ownerPid;
        GetWindowThreadProcessId(owner, out ownerPid);
        EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
            if (hwnd == owner || !IsWindowVisible(hwnd)) return true;
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pid != ownerPid) return true;
            IntPtr current = GetWindow(hwnd, 4);
            for (int depth = 0; current != IntPtr.Zero && depth < 16; depth++) {
                if (current == owner) { result.Add(hwnd); break; }
                current = GetWindow(current, 4);
            }
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
    [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    public static bool ClickVerifiedPoint(IntPtr owner, int x, int y) {
        if (GetForegroundWindow() != owner) return false;
        IntPtr hit = WindowFromPoint(new Point { X = x, Y = y });
        if (hit != owner && !IsChild(owner, hit)) return false;
        if (!SetCursorPos(x, y) || GetForegroundWindow() != owner) return false;
        hit = WindowFromPoint(new Point { X = x, Y = y });
        if (hit != owner && !IsChild(owner, hit)) return false;
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
        return true;
    }
    [StructLayout(LayoutKind.Sequential)] private struct GuiThreadInfo {
        public int Size;
        public int Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public int Left, Top, Right, Bottom;
    }
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")]
    private static extern IntPtr ReadTextTimeout(IntPtr hwnd, uint message, IntPtr wParam, StringBuilder text, uint flags, uint timeout, out IntPtr result);
    public static IntPtr FocusedEdit(IntPtr dialog) {
        if (GetForegroundWindow() != dialog) return IntPtr.Zero;
        uint pid;
        uint thread = GetWindowThreadProcessId(dialog, out pid);
        var info = new GuiThreadInfo { Size = Marshal.SizeOf(typeof(GuiThreadInfo)) };
        if (!GetGUIThreadInfo(thread, ref info) || !IsChild(dialog, info.Focus)) return IntPtr.Zero;
        var name = new StringBuilder(128);
        GetClassName(info.Focus, name, name.Capacity);
        return name.ToString() == "Edit" && IsWindowEnabled(info.Focus) ? info.Focus : IntPtr.Zero;
    }
    public static string ReadEdit(IntPtr edit) {
        if (edit == IntPtr.Zero) return "";
        var buffer = new StringBuilder(32768);
        IntPtr count;
        if (ReadTextTimeout(edit, 0x000D, (IntPtr)buffer.Capacity, buffer, 2, 1500, out count) == IntPtr.Zero) return "";
        return buffer.ToString();
    }
    public static bool SetEditText(IntPtr edit, string path) {
        if (edit == IntPtr.Zero || !IsWindow(edit) || !IsWindowEnabled(edit)) return false;
        var name = new StringBuilder(128);
        GetClassName(edit, name, name.Capacity);
        if (name.ToString() != "Edit") return false;
        IntPtr result;
        return SendMessageTimeout(edit, 0x000C, IntPtr.Zero, path, 2, 1500, out result) != IntPtr.Zero && result != IntPtr.Zero;
    }
    public static bool ClickOk(IntPtr dialog) {
        var button = GetDlgItem(dialog, 1);
        if (button == IntPtr.Zero || !IsWindowEnabled(button)) return false;
        var name = new StringBuilder(128);
        GetClassName(button, name, name.Capacity);
        if (name.ToString() != "Button") return false;
        return PostMessage(button, 0x00F5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }
    [DllImport("oleacc.dll")]
    private static extern int AccessibleObjectFromPoint(Point point,
        [MarshalAs(UnmanagedType.Interface)] out Accessibility.IAccessible accessible,
        [MarshalAs(UnmanagedType.Struct)] out object child);
    public static string DeveloperStateAtPoint(int x, int y) {
        Accessibility.IAccessible accessible;
        object child;
        if (AccessibleObjectFromPoint(new Point { X = x, Y = y }, out accessible, out child) < 0 || accessible == null)
            return "Unknown";
        // The hit can be a child label inside the switch. Only accept an
        // explicitly checkable Developer mode element, never a generic label.
        for (int depth = 0; accessible != null && depth < 5; depth++) {
            try {
                string name = accessible.get_accName(child);
                object role = accessible.get_accRole(child);
                object state = accessible.get_accState(child);
                if (String.Equals((name ?? "").Trim(), "Developer mode", StringComparison.OrdinalIgnoreCase)
                    && role is int && (int)role == 0x2c && state is int) {
                    int flags = (int)state;
                    if ((flags & (0x20 | 0x1 | 0x8000 | 0x10000)) != 0) return "Unknown";
                    return (flags & 0x10) != 0 ? "On" : "Off";
                }
                if (child is int && (int)child != 0) { child = 0; continue; }
                accessible = accessible.accParent as Accessibility.IAccessible;
                child = 0;
            } catch (COMException) { return "Unknown"; }
        }
        return "Unknown";
    }
    public static IntPtr[] Find(uint[] processes) {
        var result = new List<IntPtr>();
        var allowed = new HashSet<uint>(processes);
        EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (!allowed.Contains(pid) || !IsWindowVisible(hwnd)) return true;
            var name = new StringBuilder(128);
            GetClassName(hwnd, name, name.Capacity);
            if (name.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) result.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
}
'@
    $discovery = @{
        processes=0; windows=0; uia=0; documents=0; addressBars=0;
        readableUrls=0; matchedUrl=$false; pickerFound=$false; pickerEditFound=$false; pickerPathSet=$false; pickerConfirmed=$false; pickerMethod='not selected'; loadMethod='not attempted'; loadInvokeCompleted=$false; developerState='Not checked'; developerActivationSent=$false
    }
    function Browser-Windows {
        $processIds = @(
            Get-Process -Name chrome,chromium -ErrorAction SilentlyContinue | ForEach-Object {
                try {
                    if ($_.Path -and [string]::Equals($_.Path,$browser,[StringComparison]::OrdinalIgnoreCase)) {
                        [uint32]$_.Id
                    }
                } catch {}
            }
        )
        $discovery.processes=$processIds.Count
        $handles=@([QueueOptimizerChromiumWindows]::Find([uint32[]]$processIds))
        $discovery.windows=$handles.Count
        $discovery.uia=0
        foreach ($handle in $handles) {
            try {
                $window=[System.Windows.Automation.AutomationElement]::FromHandle($handle)
                if ($window) {
                    $discovery.uia++
                    $window
                }
            } catch [System.Windows.Automation.ElementNotAvailableException] {}
        }
    }
    function Wait-For([string]$description,[scriptblock]$probe,[int]$seconds=20) {
        $until = [DateTime]::UtcNow.AddSeconds($seconds)
        do {
            try {
                $found = & $probe
                if ($found) { return $found }
            } catch [System.Windows.Automation.ElementNotAvailableException] {}
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $until)
        throw "Chromium setup could not find $description. Open chrome://extensions, enable Developer mode, and choose Load unpacked with the ChatGPT Queue Optimizer extension folder, or retry installation."
    }
    function Named-Control($parent,[string]$name) {
        # Match accessibility names case-insensitively. Chromium may expose
        # controls under either a native UIA provider or an MSAA proxy.
        $condition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty,$name,
            [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase)
        foreach ($item in $parent.FindAll($descendants,$condition)) {
            if ($item.Current.IsEnabled -and -not $item.Current.IsOffscreen) { return $item }
        }
    }
    function Invoke-Control($element) {
        $pattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {
            $pattern.Invoke()
        } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)) {
            $pattern.Toggle()
        } else { throw 'Chromium control cannot be activated through Windows accessibility.' }
    }

    function Is-ExtensionsUrl([string]$value) {
        return ($value.Trim() -in @('chrome://extensions','chrome://extensions/'))
    }
    function Read-AccessibleUrl($element,[bool]$allowText) {
        # The root web area can expose the committed document URL even when
        # the address bar is missing or elides part of the displayed URL.
        $value=$null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$value)) {
            $url=$value.Current.Value
            if ($url) { return [string]$url }
        }
        if ($allowText) {
            $value=$null
            if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$value)) {
                return [string]$value.DocumentRange.GetText(512)
            }
        }
        return ''
    }
    function Is-ExtensionsPage($window) {
        $elements=$window.FindAll($descendants,$any)
        $discovery.documents=0
        $discovery.addressBars=0
        $discovery.readableUrls=0
        $discovery.matchedUrl=$false
        $documentUrlFound=$false
        # Prefer the active document's committed URL; an omnibox draft is
        # not proof of navigation. RootWebArea may be a pane or a document.
        foreach ($element in $elements) {
            try {
                if ($element.Current.IsOffscreen) { continue }
                if ($element.Current.AutomationId -ne 'RootWebArea' -and
                    $element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Document) { continue }
                $discovery.documents++
                $url=Read-AccessibleUrl $element $false
                if (-not $url) { continue }
                if ($url -notmatch '^[a-z][a-z0-9+.-]*://') { continue }
                $documentUrlFound=$true
                $discovery.readableUrls++
                if (Is-ExtensionsUrl $url) {
                    $discovery.matchedUrl=$true
                    return $true
                }
            } catch [System.Windows.Automation.ElementNotAvailableException] {}
        }
        if ($documentUrlFound) { return $false }
        foreach ($element in $elements) {
            try {
                if ($element.Current.IsOffscreen -or $element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) { continue }
                if ($element.Current.Name -notmatch '(?i)address and search bar|^address bar$|^omnibox$|^location bar$' -and
                    $element.Current.AutomationId -notmatch '(?i)omnibox|addressbar') { continue }
                # Reject page-owned inputs with spoofed address-bar names.
                $parent=[System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($element)
                $inDocument=$false
                while ($parent) {
                    if ($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document -or $parent.Current.AutomationId -eq 'RootWebArea') {
                        $inDocument=$true; break
                    }
                    if ($parent.Current.NativeWindowHandle -eq $window.Current.NativeWindowHandle) { break }
                    $parent=[System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($parent)
                }
                if ($inDocument -or $element.Current.HasKeyboardFocus) { continue }
                $discovery.addressBars++
                $url=Read-AccessibleUrl $element $true
                if ($url) {
                    $discovery.readableUrls++
                    if (Is-ExtensionsUrl $url) {
                        $discovery.matchedUrl=$true
                        return $true
                    }
                }
            } catch [System.Windows.Automation.ElementNotAvailableException] {}
        }
        return $false
    }

    function Find-BrowserAddressBar($window) {
        foreach ($element in $window.FindAll($descendants,$any)) {
            try {
                if ($element.Current.IsOffscreen -or -not $element.Current.IsEnabled -or
                    $element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) { continue }
                if ($element.Current.Name -notmatch '(?i)address and search bar|^address bar$|^omnibox$|^location bar$' -and
                    $element.Current.AutomationId -notmatch '(?i)omnibox|addressbar') { continue }
                $parent=[System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($element)
                $inDocument=$false
                while ($parent) {
                    if ($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document -or $parent.Current.AutomationId -eq 'RootWebArea') {
                        $inDocument=$true; break
                    }
                    if ($parent.Current.NativeWindowHandle -eq $window.Current.NativeWindowHandle) { break }
                    $parent=[System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($parent)
                }
                if (-not $inDocument) { return $element }
            } catch [System.Windows.Automation.ElementNotAvailableException] {}
        }
    }
    function Navigate-ToExtensions($window) {
        # Explicitly navigate only a browser window created for this setup.
        # Some Chromium builds or launchers discard command-line URLs.
        $handle=[IntPtr]$window.Current.NativeWindowHandle
        [QueueOptimizerChromiumWindows]::Restore($handle)
        $null=[QueueOptimizerChromiumWindows]::SetForegroundWindow($handle)
        $address=Wait-For 'the new Chromium window address bar (finish any profile chooser first)' {
            Find-BrowserAddressBar $window
        } 15
        $address.SetFocus()
        $null=Wait-For 'focus on the Chromium address bar' {
            if ([QueueOptimizerChromiumWindows]::GetForegroundWindow() -eq $handle -and $address.Current.HasKeyboardFocus) { return $true }
        } 5
        # Prefer the address bar's own ValuePattern. Keyboard input is
        # permitted only with the verified browser HWND and omnibox focused.
        $value=$null
        $set=$false
        if ($address.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$value) -and -not $value.Current.IsReadOnly) {
            try {
                $value.SetValue('chrome://extensions/')
                $set=($value.Current.Value -in @('chrome://extensions','chrome://extensions/'))
            } catch {}
        }
        Add-Type -AssemblyName System.Windows.Forms
        if ([QueueOptimizerChromiumWindows]::GetForegroundWindow() -ne $handle -or -not $address.Current.HasKeyboardFocus) {
            throw 'Chromium address bar lost focus before navigation. No keyboard input was sent.'
        }
        if ($set) {
            [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        } else {
            [System.Windows.Forms.SendKeys]::SendWait('^achrome://extensions/{ENTER}')
        }
    }

    $stage='find Chromium Extensions window'
    # Reuse a verified Extensions page; otherwise create a setup window.
    $window=Browser-Windows | Where-Object { Is-ExtensionsPage $_ } | Select-Object -First 1
    if (-not $window) {
        $oldHandles=@(Browser-Windows | ForEach-Object { $_.Current.NativeWindowHandle })
        Start-Process -FilePath $browser -ArgumentList @('--new-window','--force-renderer-accessibility=complete','--enable-features=UiaProvider','chrome://extensions/') | Out-Null
        $stage='wait for Chromium setup window'
        $window=Wait-For 'the newly opened Chromium window' {
            foreach ($w in Browser-Windows) {
                if (Is-ExtensionsPage $w) { return $w }
                if ($oldHandles -notcontains $w.Current.NativeWindowHandle -and (Find-BrowserAddressBar $w)) { return $w }
            }
        } 40
        if (-not (Is-ExtensionsPage $window)) {
            $stage='navigate Chromium to chrome://extensions'
            Navigate-ToExtensions $window
        }
        $stage='verify Chromium Extensions page'
        $null=Wait-For 'the Chromium window displaying chrome://extensions' {
            if (Is-ExtensionsPage $window) { return $true }
        } 20
    }
    function Optional-UiaProperty($element,[int]$id) {
        # Windows PowerShell uses the older .NET Framework UIAutomation API.
        # LookupById may return null for unsupported newer UIA properties.
        try {
            $property=[System.Windows.Automation.AutomationProperty]::LookupById($id)
            if ($null -ne $property) {
                $value=$element.GetCurrentPropertyValue($property,$true)
                if ($value -is [string]) { return $value }
            }
        } catch {}
        return ''
    }

    function Read-DeveloperState($switch) {
        if (-not $switch) { return 'Unknown' }
        $pattern=$null
        if ($switch.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)) {
            if ($pattern.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { return 'On' }
            if ($pattern.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Off) { return 'Off' }
        }
        $properties=Optional-UiaProperty $switch 30102 # UIA_AriaPropertiesPropertyId
        if ($properties -match '(?i)(?:^|[;,]\s*)(?:checked|pressed)\s*=\s*true(?:[;,]|$)') { return 'On' }
        if ($properties -match '(?i)(?:^|[;,]\s*)(?:checked|pressed)\s*=\s*false(?:[;,]|$)') { return 'Off' }
        # Obtain legacy accessibility state directly from oleacc, not a
        # LegacyIAccessiblePattern type absent from some managed UIA builds.
        $bounds=$switch.Current.BoundingRectangle
        if (-not $bounds.IsEmpty -and $bounds.Width -gt 0 -and $bounds.Height -gt 0) {
            $x=[int]($bounds.X+$bounds.Width/2)
            $y=[int]($bounds.Y+$bounds.Height/2)
            $windowHandle=[IntPtr]$window.Current.NativeWindowHandle
            if ([QueueOptimizerChromiumWindows]::GetForegroundWindow() -eq $windowHandle) {
                return [QueueOptimizerChromiumWindows]::DeveloperStateAtPoint($x,$y)
            }
        }
        return 'Unknown'
    }

    function Find-DeveloperSwitch($page) {
        $candidate=$null
        foreach ($element in $page.FindAll($descendants,$any)) {
            try {
                if ($element.Current.IsOffscreen -or -not $element.Current.IsEnabled) { continue }
                if ($element.Current.Name -notmatch '^\s*Developer mode\s*$' -and $element.Current.AutomationId -notin @('devMode','dev-mode')) { continue }
                $pattern=$null
                if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)) { return $element }
                $type=$element.Current.ControlType
                $aria=Optional-UiaProperty $element 30101 # UIA_AriaRolePropertyId
                if ($type -in @([System.Windows.Automation.ControlType]::CheckBox,[System.Windows.Automation.ControlType]::Button) -or
                    $aria -in @('switch','checkbox','togglebutton') -or $element.Current.IsKeyboardFocusable) {
                    if ((Read-DeveloperState $element) -ne 'Unknown') { return $element }
                    if (-not $candidate) { $candidate=$element }
                }
            } catch [System.Windows.Automation.ElementNotAvailableException] {}
        }
        return $candidate
    }

    $stage='detect Developer mode controls'
    $null=Wait-For 'Developer mode switch or Load unpacked on the verified Extensions page' {
        if (Is-ExtensionsPage $window) {
            if ((Named-Control $window 'Load unpacked') -or (Find-DeveloperSwitch $window)) { return $true }
        }
    } 30
    if (-not (Is-ExtensionsPage $window)) { throw 'The Chromium Extensions tab was changed during setup.' }
    $load=Named-Control $window 'Load unpacked'
    if (-not $load) {
        $stage='read Developer mode switch state'
        $owner=[IntPtr]$window.Current.NativeWindowHandle
        [QueueOptimizerChromiumWindows]::Restore($owner)
        $null=[QueueOptimizerChromiumWindows]::SetForegroundWindow($owner)
        $toggle=Find-DeveloperSwitch $window
        $state=Read-DeveloperState $toggle
        $discovery.developerState=$state
        if ($state -eq 'Unknown') {
            throw 'Could not determine Chromium Developer mode state from Toggle, ARIA, or accessibility check state. No setting was changed.'
        }
        if ($state -eq 'Off') {
            $stage='enable Developer mode'
            $owner=[IntPtr]$window.Current.NativeWindowHandle
            [QueueOptimizerChromiumWindows]::Restore($owner)
            $null=[QueueOptimizerChromiumWindows]::SetForegroundWindow($owner)
            $toggle.SetFocus()
            $null=Wait-For 'focus on the Developer mode switch' {
                if ([QueueOptimizerChromiumWindows]::GetForegroundWindow() -eq $owner -and $toggle.Current.HasKeyboardFocus) { return $true }
            } 5
            # Recheck immediately before acting. Never toggle an enabled switch.
            $state=Read-DeveloperState $toggle
            $discovery.developerState=$state
            if ($state -eq 'Off') {
                Add-Type -AssemblyName System.Windows.Forms
                if ([QueueOptimizerChromiumWindows]::GetForegroundWindow() -ne $owner -or -not $toggle.Current.HasKeyboardFocus) {
                    throw 'Developer mode switch lost focus. No setting was changed.'
                }
                [System.Windows.Forms.SendKeys]::SendWait(' ')
                $discovery.developerActivationSent=$true
            } elseif ($state -ne 'On') {
                throw 'Developer mode state changed and could not be verified. No setting was changed.'
            }
        }
    } else {
        $discovery.developerState='On (Load unpacked available)'
    }
    $stage='verify Developer mode and Load unpacked'
    $load=Wait-For 'the Load unpacked button (Developer mode)' {
        if (Is-ExtensionsPage $window) { Named-Control $window 'Load unpacked' }
    } 25
    $discovery.developerState='On (verified)'
    function Extension-Visible {
        if (-not (Is-ExtensionsPage $window)) { return $false }
        foreach ($element in $window.FindAll($descendants,$any)) {
            try {
                $name = $element.Current.Name
                if ($name -eq $id -or $name -eq "ID: $id") { return $true }
            } catch [System.Windows.Automation.ElementNotAvailableException] {}
        }
        return $false
    }
    # Reload only the existing dedicated local ID; never remove a store copy.
    function Find-LocalReload {
        if (-not (Is-ExtensionsPage $window)) { throw 'Chromium Extensions page changed.' }
        foreach ($element in $window.FindAll($descendants,$any)) {
            if ($element.Current.Name -notin @($id,"ID: $id")) { continue }
            $ancestor=[System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($element)
            for ($depth=0; $ancestor -and $depth -lt 12; $depth++) {
                if ($ancestor.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document -or
                    $ancestor.Current.AutomationId -eq 'RootWebArea' -or
                    [System.Windows.Automation.Automation]::Compare($ancestor,$window)) { break }
                $nodes=@($ancestor.FindAll($descendants,$any))
                $other=@($nodes | Where-Object { $_.Current.Name -match '^(?:ID:\s*)?([a-p]{32})$' -and $Matches[1] -cne $id })
                if ($other.Count) { break }
                $reload=@($nodes | Where-Object {
                    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.IsEnabled -and -not $_.Current.IsOffscreen -and
                    $_.Current.Name -in @('Reload','Reload ChatGPT Queue + Optimizer','Reload extension')
                })
                if ($reload.Count -gt 1) { break }
                if ($reload.Count -eq 1) { return $reload[0] }
                $ancestor=[System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($ancestor)
            }
        }
    }
    $stage='detect existing local extension'
    $existing=$false
    for ($attempt=0; $attempt -lt 8; $attempt++) {
        if (-not (Is-ExtensionsPage $window)) { throw 'Chromium Extensions page changed.' }
        if (Extension-Visible) { $existing=$true; break }
        Start-Sleep -Milliseconds 250
    }
    if ($existing) {
        $stage='reload exact local extension ID'
        $reload=Wait-For 'Reload on the card with the exact local extension ID' { Find-LocalReload } 15
        if (-not (Is-ExtensionsPage $window)) { throw 'Chromium Extensions page changed before reload.' }
        Invoke-Control $reload
        Start-Sleep -Milliseconds 1000
        $null=Wait-For 'local extension ID after reload' { if (Extension-Visible) { $true } } 20
        Write-Output "Reload requested for the verified local $product extension ID $id (source version $version)."
        exit 0
    }
    $stage='open extension folder picker'
    $ownerHandle=[IntPtr]$window.Current.NativeWindowHandle
    $previousDialogs=@([QueueOptimizerChromiumWindows]::OwnedDialogs($ownerHandle))
    if (-not (Is-ExtensionsPage $window)) { throw 'The Chromium Extensions tab was changed during setup.' }

    # Invoke the accessible button on an independent PowerShell runspace.
    # Some Chromium UIA providers block Invoke until the modal dialog closes;
    # the main STA must remain free to discover and operate that dialog.
    Add-Type -AssemblyName System.Windows.Forms
    [QueueOptimizerChromiumWindows]::Restore($ownerHandle)
    $null=[QueueOptimizerChromiumWindows]::SetForegroundWindow($ownerHandle)
    $condition=[System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty,'Load unpacked',
        [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase)
    $invokeTarget=$null
    foreach ($candidate in $window.FindAll($descendants,$condition)) {
        if ($candidate.Current.IsOffscreen -or -not $candidate.Current.IsEnabled) { continue }
        $pattern=$null
        if ($candidate.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {
            $invokeTarget=$candidate
            break
        }
    }
    $invokeWorker=$null
    $invokePending=$null
    if ($invokeTarget) {
        if (-not (Is-ExtensionsPage $window)) { throw 'The Chromium Extensions tab was changed before Load unpacked activation.' }
        $invokeWorker=[PowerShell]::Create()
        $null=$invokeWorker.AddScript({
            param($target)
            $ErrorActionPreference='Stop'
            $pattern=$target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $pattern.Invoke()
        }.ToString()).AddArgument($invokeTarget)
        $invokePending=$invokeWorker.BeginInvoke()
        $discovery.loadMethod='asynchronous UIA Invoke'
    } else {
        # Fallback for providers exposing a button without InvokePattern.
        # Use a hit-tested clickable point, never an unverified coordinate.
        $load=Named-Control $window 'Load unpacked'
        if (-not $load -or -not (Is-ExtensionsPage $window)) { throw 'Load unpacked is no longer available on the verified Extensions page.' }
        $point=New-Object System.Windows.Point
        if (-not $load.TryGetClickablePoint([ref]$point)) { throw 'Load unpacked has neither an InvokePattern nor an accessible clickable point.' }
        $hit=[System.Windows.Automation.AutomationElement]::FromPoint($point)
        $matched=$false
        for ($depth=0; $hit -and $depth -lt 8; $depth++) {
            if ([System.Windows.Automation.Automation]::Compare($hit,$load)) { $matched=$true; break }
            $hit=[System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($hit)
        }
        if (-not $matched) { throw 'The Load unpacked clickable point is obstructed or belongs to another control.' }
        if (-not [QueueOptimizerChromiumWindows]::ClickVerifiedPoint($ownerHandle,[int]$point.X,[int]$point.Y)) {
            throw 'The verified Load unpacked button could not be clicked because Chromium lost foreground focus.'
        }
        $discovery.loadMethod='verified button click'
    }
    $pickerHandle=Wait-For 'the newly opened Chromium-owned folder picker' {
        foreach ($handle in [QueueOptimizerChromiumWindows]::OwnedDialogs($ownerHandle)) {
            if ($previousDialogs -notcontains $handle) { return $handle }
        }
        if ($invokePending -and $invokePending.IsCompleted -and -not $discovery.loadInvokeCompleted) {
            $discovery.loadInvokeCompleted=$true
            try { $null=$invokeWorker.EndInvoke($invokePending) }
            catch { throw ('Load unpacked invocation failed: {0}' -f $_.Exception.Message) }
        }
    } 25
    $discovery.pickerFound=$true
    $picker=[System.Windows.Automation.AutomationElement]::FromHandle($pickerHandle)

    function Assert-PickerForeground {
        if ([QueueOptimizerChromiumWindows]::OwnedDialogs($ownerHandle) -notcontains $pickerHandle -or
            [QueueOptimizerChromiumWindows]::GetForegroundWindow() -ne $pickerHandle) {
            throw 'The original Chromium folder picker is no longer in the foreground. No further keyboard input was sent.'
        }
    }
    function Focus-PickerAddress {
        Assert-PickerForeground
        # The Windows common folder dialog supports Alt+D and Ctrl+L even
        # when its Folder field is missing from the UI Automation tree.
        foreach ($shortcut in @('%d','^l')) {
            Assert-PickerForeground
            [System.Windows.Forms.SendKeys]::SendWait($shortcut)
            for ($attempt=0; $attempt -lt 10; $attempt++) {
                Assert-PickerForeground
                $edit=[QueueOptimizerChromiumWindows]::FocusedEdit($pickerHandle)
                if ($edit -ne [IntPtr]::Zero) { return $edit }
                Start-Sleep -Milliseconds 100
            }
        }
        throw 'The folder picker address bar could not be focused using Alt+D or Ctrl+L.'
    }
    function Is-ExactExtensionFolder([string]$candidate) {
        try {
            if (-not [IO.Path]::IsPathRooted($candidate)) { return $false }
            $resolved=(Resolve-Path -LiteralPath $candidate -ErrorAction Stop).ProviderPath
            return [string]::Equals($resolved.TrimEnd('\','/'),$extension.TrimEnd('\','/'),[StringComparison]::OrdinalIgnoreCase)
        } catch { return $false }
    }
    function Navigate-PickerToExtension {
        $stage='navigate folder picker address bar'
        [QueueOptimizerChromiumWindows]::Restore($pickerHandle)
        $null=[QueueOptimizerChromiumWindows]::SetForegroundWindow($pickerHandle)
        $null=Wait-For 'foreground focus on the Chromium folder picker' {
            if ([QueueOptimizerChromiumWindows]::GetForegroundWindow() -eq $pickerHandle) { return $true }
        } 5
        $address=Focus-PickerAddress
        $discovery.pickerEditFound=$true
        $discovery.pickerMethod='address bar'
        Assert-PickerForeground
        if ([QueueOptimizerChromiumWindows]::FocusedEdit($pickerHandle) -ne $address) { throw 'Folder address bar lost focus.' }
        # Target the native edit directly; no clipboard or global paste.
        if (-not [QueueOptimizerChromiumWindows]::SetEditText($address,$extension)) { throw 'Windows rejected the extension path in the address bar.' }
        if (-not (Is-ExactExtensionFolder ([QueueOptimizerChromiumWindows]::ReadEdit($address)))) { throw 'The address bar did not contain the exact extension path.' }
        Assert-PickerForeground
        if ([QueueOptimizerChromiumWindows]::FocusedEdit($pickerHandle) -ne $address) { throw 'Folder address bar lost focus before navigation.' }
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        # Confirm navigation actually completed, not just that we wrote text.
        Start-Sleep -Milliseconds 700
        $until=[DateTime]::UtcNow.AddSeconds(12)
        do {
            if (-not [QueueOptimizerChromiumWindows]::IsWindow($pickerHandle)) { return }
            Assert-PickerForeground
            $current=Focus-PickerAddress
            $actual=[QueueOptimizerChromiumWindows]::ReadEdit($current)
            $matches=Is-ExactExtensionFolder $actual
            Assert-PickerForeground
            if ([QueueOptimizerChromiumWindows]::FocusedEdit($pickerHandle) -ne $current) { throw 'Folder address bar lost focus during location verification.' }
            [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
            if ($matches) {
                $discovery.pickerPathSet=$true
                return
            }
            Start-Sleep -Milliseconds 300
        } while ([DateTime]::UtcNow -lt $until)
        throw 'The folder selector did not navigate to the exact ChatGPT Queue Optimizer extension directory.'
    }

    $stage='enter extension folder path'
    # Prefer navigation through the address bar: the dialog can start in
    # Documents and some Windows versions have no accessible Folder input.
    Navigate-PickerToExtension
    if (-not [QueueOptimizerChromiumWindows]::IsWindow($pickerHandle)) {
        $stage='verify installed extension ID'
        $null=Wait-For 'the installed ChatGPT Queue Optimizer extension ID' { if (Extension-Visible) { $true } }
        Write-Output "message=$product Developer mode is enabled and ChatGPT Queue Optimizer $version is installed in the opened browser profile."
        exit 0
    }
    $stage='confirm extension folder selection'
    if ([QueueOptimizerChromiumWindows]::OwnedDialogs($ownerHandle) -notcontains $pickerHandle) {
        throw 'The original Chromium folder picker disappeared before selection.'
    }
    $select=Named-Control $picker 'Select Folder'
    if (-not $select) { $select=Named-Control $picker 'Select' }
    if (-not $select) { $select=Named-Control $picker 'Open' }
    if (-not [QueueOptimizerChromiumWindows]::ClickOk($pickerHandle)) {
        if (-not $select) { throw 'The folder picker did not expose its Select Folder button.' }
        Invoke-Control $select
    }
    $discovery.pickerConfirmed=$true
    # Confirm the dialog closed. If Windows interpreted the full directory
    # as navigation instead of selection, do not blindly click again: the
    # final installed-ID check determines whether the operation succeeded.
    $null=Wait-For 'the folder picker to close after selection' {
        if (-not [QueueOptimizerChromiumWindows]::IsWindow($pickerHandle)) { return $true }
    } 15
    $stage='verify installed extension ID'
    $null = Wait-For 'the installed ChatGPT Queue Optimizer extension ID' { if (Extension-Visible) { $true } }
    Write-Output "message=$product Developer mode is enabled and ChatGPT Queue Optimizer $version is installed in the opened browser profile."
    exit 0
} catch {
    [Console]::Error.WriteLine(('Chromium setup stage: {0}. {1}' -f $stage,$_.Exception.Message))
    if ($discovery) {
        [Console]::Error.WriteLine(('Detection: Chromium processes={0}; native windows={1}; UIA windows={2}; documents={3}; address bars={4}; readable URL values={5}; Extensions URL matched={6}.' -f $discovery.processes,$discovery.windows,$discovery.uia,$discovery.documents,$discovery.addressBars,$discovery.readableUrls,$discovery.matchedUrl))
    }
    if ($discovery) {
        [Console]::Error.WriteLine(('Load unpacked: method={0}; invocation completed={1}.' -f $discovery.loadMethod,$discovery.loadInvokeCompleted))
        [Console]::Error.WriteLine(('Developer mode: {0}; activation sent={1}.' -f $discovery.developerState,$discovery.developerActivationSent))
        [Console]::Error.WriteLine(('Folder picker: found={0}; input found={1}; path entered={2}; confirmation sent={3}; method={4}.' -f $discovery.pickerFound,$discovery.pickerEditFound,$discovery.pickerPathSet,$discovery.pickerConfirmed,$discovery.pickerMethod))
    }
    exit 1
}
