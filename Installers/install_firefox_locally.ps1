# Adapted from pi-vault/scripts/install-firefox-extension.ps1.
# Temporary local Firefox installation only; no signature preferences or permanent add-on removal.
param([string]$FirefoxPath)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$stage='validate XPI'
try {
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.IO.Compression.FileSystem
    Add-Type -AssemblyName System.Windows.Forms
    $repo=Split-Path -Parent $PSScriptRoot
    $archive=Join-Path $repo 'build\chatgpt-queue-optimizer-firefox-store.zip'
    $archive=(Resolve-Path -LiteralPath $archive).ProviderPath
    $localDir=Join-Path $repo 'build\local-firefox'
    New-Item -ItemType Directory -Path $localDir -Force | Out-Null
    $hash=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    $xpi=Join-Path $localDir ("chatgpt-queue-optimizer-"+$hash+".xpi")
    if (-not (Test-Path -LiteralPath $xpi -PathType Leaf)) {
        $staged=Join-Path $localDir ([Guid]::NewGuid().ToString()+'.tmp')
        try {
            Copy-Item -LiteralPath $archive -Destination $staged
            if ((Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hash) { throw 'Firefox package changed while copying.' }
            Move-Item -LiteralPath $staged -Destination $xpi
        } finally {
            if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Force }
        }
    }
    if ((Get-FileHash -LiteralPath $xpi -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hash) { throw 'Cached Firefox XPI hash mismatch.' }
    $expectedVersion=(Get-Content -LiteralPath (Join-Path $repo 'manifest.json') -Raw | ConvertFrom-Json).version
    $addonId='chatgpt-queue-optimizer@marsluay.local'
    if ([IO.Path]::GetExtension($xpi) -ne '.xpi') { throw 'Expected an XPI file.' }
    $zip=[IO.Compression.ZipFile]::OpenRead($xpi)
    try {
        $entry=$zip.GetEntry('manifest.json')
        if (-not $entry -or $entry.Length -gt 1048576) { throw 'XPI manifest missing or invalid.' }
        $reader=New-Object IO.StreamReader($entry.Open())
        try { $manifest=$reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        $gecko=$manifest.browser_specific_settings.gecko.id
        if (-not $gecko) { $gecko=$manifest.applications.gecko.id }
        if ($gecko -cne $addonId -or $manifest.name -cne 'ChatGPT Queue + Optimizer' -or $manifest.version -cne $expectedVersion -or $manifest.manifest_version -ne 2) {
            throw 'The XPI does not match the pinned ChatGPT Queue Optimizer identity.'
        }
        $version=[string]$manifest.version
    } finally { $zip.Dispose() }

    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class QueueOptimizerFirefoxWindows {
    private delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc fn, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hwnd,int command);
    public static void Restore(IntPtr hwnd) { if (IsIconic(hwnd)) ShowWindowAsync(hwnd,9); }
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach,uint target,bool value);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hwnd);
    public static bool RecoverForeground(IntPtr hwnd) {
        if (!IsWindow(hwnd)) return false;
        Restore(hwnd);
        if (GetForegroundWindow()==hwnd) return true;
        SetForegroundWindow(hwnd);
        if (GetForegroundWindow()==hwnd) return true;
        IntPtr foreground=GetForegroundWindow();
        uint ignored;
        uint target=GetWindowThreadProcessId(hwnd,out ignored);
        uint active=foreground==IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground,out ignored);
        uint self=GetCurrentThreadId();
        bool activeAttached=false, targetAttached=false;
        try {
            if (active!=0 && active!=self) activeAttached=AttachThreadInput(self,active,true);
            if (target!=0 && target!=self && target!=active) targetAttached=AttachThreadInput(self,target,true);
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
        } finally {
            if (targetAttached) AttachThreadInput(self,target,false);
            if (activeAttached) AttachThreadInput(self,active,false);
        }
        return GetForegroundWindow()==hwnd;
    }
    public static uint ProcessId(IntPtr hwnd) {
        uint pid; GetWindowThreadProcessId(hwnd,out pid); return pid;
    }
    [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X; public int Y; }
    public static IntPtr[] Windows(uint[] pids, IntPtr owner) {
        var allowed = new HashSet<uint>(pids); var result = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
            uint pid; GetWindowThreadProcessId(hwnd,out pid);
            if (!allowed.Contains(pid) || !IsWindowVisible(hwnd) || hwnd == owner) return true;
            if (owner == IntPtr.Zero) { if (GetWindow(hwnd,4)==IntPtr.Zero && ClassOf(hwnd)=="MozillaWindowClass") result.Add(hwnd); return true; }
            IntPtr parent = GetWindow(hwnd,4);
            for (int i=0;parent!=IntPtr.Zero && i<16;i++) {
                if (parent==owner) { result.Add(hwnd); break; }
                parent=GetWindow(parent,4);
            }
            return true;
        },IntPtr.Zero);
        return result.ToArray();
    }
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hwnd, EnumProc fn, IntPtr data);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd,StringBuilder name,int capacity);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr hwnd,int id);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] private static extern IntPtr WriteText(IntPtr hwnd,uint message,IntPtr wParam,string text,uint flags,uint timeout,out IntPtr result);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] private static extern IntPtr ReadText(IntPtr hwnd,uint message,IntPtr wParam,StringBuilder text,uint flags,uint timeout,out IntPtr result);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr wParam,IntPtr lParam);
    private static string ClassOf(IntPtr hwnd) {
        var name=new StringBuilder(128);
        GetClassName(hwnd,name,name.Capacity);
        return name.ToString();
    }
    private static bool OwnedBy(IntPtr hwnd,IntPtr owner) {
        for (IntPtr current=GetWindow(hwnd,4);current!=IntPtr.Zero;current=GetWindow(current,4)) {
            if (current==owner) return true;
        }
        return false;
    }
    // Windows may create a common dialog in a different process. Require
    // the exact owner chain and native dialog class rather than the PID.
    public static IntPtr[] OwnedFileDialogs(IntPtr owner) {
        var result=new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd,IntPtr data) {
            if (IsWindowVisible(hwnd) && ClassOf(hwnd)=="#32770" && OwnedBy(hwnd,owner))
                result.Add(hwnd);
            return true;
        },IntPtr.Zero);
        return result.ToArray();
    }
    public static IntPtr FileNameEdit(IntPtr dialog) {
        if (!IsWindow(dialog) || ClassOf(dialog)!="#32770") return IntPtr.Zero;
        // Common dialog IDs: edt1=0x480, cmb13=0x47c (File name).
        // Never choose an arbitrary Edit such as the address/search box.
        var matches=new HashSet<IntPtr>();
        EnumChildWindows(dialog,delegate(IntPtr child,IntPtr data) {
            if (ClassOf(child)!="Edit" || !IsWindowVisible(child) || !IsWindowEnabled(child)) return true;
            if (GetDlgCtrlID(child)==0x480) { matches.Add(child); return true; }
            for (IntPtr parent=GetParent(child);parent!=IntPtr.Zero && parent!=dialog;parent=GetParent(parent)) {
                if (GetDlgCtrlID(parent)==0x47c) { matches.Add(child); break; }
            }
            return true;
        },IntPtr.Zero);
        if (matches.Count!=1) return IntPtr.Zero;
        foreach (var match in matches) return match;
        return IntPtr.Zero;
    }
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hwnd);
    public static bool IsFileDialog(IntPtr dialog,IntPtr owner) {
        return IsWindow(dialog) && IsWindowVisible(dialog) && OwnedBy(dialog,owner)
            && ClassOf(dialog)=="#32770" && ClassOf(GetDlgItem(dialog,1))=="Button"
            && ClassOf(GetDlgItem(dialog,2))=="Button";
    }
    public static bool SetFileName(IntPtr dialog,IntPtr owner,string path) {
        if (GetForegroundWindow()!=dialog || !IsFileDialog(dialog,owner)) return false;
        var edit=FileNameEdit(dialog);
        if (edit==IntPtr.Zero) return false;
        IntPtr result;
        if (WriteText(edit,0x000C,IntPtr.Zero,path,2,1500,out result)==IntPtr.Zero || result==IntPtr.Zero) return false;
        var buffer=new StringBuilder(32768);
        if (ReadText(edit,0x000D,(IntPtr)buffer.Capacity,buffer,2,1500,out result)==IntPtr.Zero) return false;
        return String.Equals(buffer.ToString(),path,StringComparison.OrdinalIgnoreCase);
    }
    public static bool SubmitFileDialog(IntPtr dialog,IntPtr owner) {
        if (GetForegroundWindow()!=dialog || !IsFileDialog(dialog,owner)) return false;
        IntPtr button=GetDlgItem(dialog,1);
        return IsWindowEnabled(button) && PostMessage(button,0x00F5,IntPtr.Zero,IntPtr.Zero);
    }
    public static bool Click(IntPtr foreground,int x,int y) {
        if (GetForegroundWindow()!=foreground) return false;
        IntPtr hit=WindowFromPoint(new Point {X=x,Y=y});
        if (hit!=foreground && !IsChild(foreground,hit)) return false;
        if (!SetCursorPos(x,y) || GetForegroundWindow()!=foreground) return false;
        hit=WindowFromPoint(new Point {X=x,Y=y});
        if (hit!=foreground && !IsChild(foreground,hit)) return false;
        mouse_event(2,0,0,0,UIntPtr.Zero); mouse_event(4,0,0,0,UIntPtr.Zero);
        return true;
    }
}
'@
    $any=[System.Windows.Automation.Condition]::TrueCondition
    $desc=[System.Windows.Automation.TreeScope]::Descendants
    $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
    function Wait-For([string]$description,[scriptblock]$probe,[int]$seconds=25) {
        $until=[DateTime]::UtcNow.AddSeconds($seconds)
        do {
            try { $value=& $probe; if ($value) { return $value } }
            catch [System.Windows.Automation.ElementNotAvailableException] {}
            Start-Sleep -Milliseconds 200
        } while ([DateTime]::UtcNow -lt $until)
        throw "Could not verify $description."
    }
    function Elements($root) {
        if ($root) { $root; foreach ($item in $root.FindAll($desc,$any)) { $item } }
    }
    function Visible($item) {
        return $item -and -not $item.Current.IsOffscreen -and $item.Current.IsEnabled
    }
    function Find-Control($root,[string]$pattern,[string[]]$types) {
        foreach ($item in (Elements $root)) {
            if ((Visible $item) -and $item.Current.Name -match $pattern -and
                $item.Current.ControlType.ProgrammaticName -in $types) { return $item }
        }
    }
    function Is-AddressBar($item,$root) {
        if ($item.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) { return $false }
        if ($item.Current.AutomationId -notmatch '(?i)urlbar|address|location' -and
            $item.Current.Name -notmatch '(?i)address|location bar|url bar|search or enter') { return $false }
        $parent=[System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($item)
        while ($parent) {
            if ($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { return $false }
            if ([System.Windows.Automation.Automation]::Compare($parent,$root)) { return $true }
            $parent=[System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($parent)
        }
        return $false
    }
    function Read-AccessibleValue($item) {
        $value=$null
        if ($item.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$value)) {
            if ($value.Current.Value) { return [string]$value.Current.Value }
        }
        # Firefox may expose the location field through the legacy UIA
        # accessibility bridge rather than ValuePattern.
        try {
            $property=[System.Windows.Automation.AutomationProperty]::LookupById(30093)
            if ($property) {
                $legacy=$item.GetCurrentPropertyValue($property,$true)
                if ($legacy -is [string] -and $legacy) { return $legacy }
            }
        } catch {}
        return ''
    }
    function Has-PageMarkers($root,[string]$page) {
        # The URL is still required. These markers distinguish a loaded
        # privileged page from an uncommitted URL typed in the address bar.
        $names=@((Elements $root) | ForEach-Object { $_.Current.Name })
        switch ($page) {
            'about:debugging' {
                return [bool](($names -match '^This Firefox$') -and
                    ($names -match '^Load Temporary Add-on(?:\.{3}|\u2026)?$'))
            }
            'about:addons' {
                return [bool](($names -match '^Extensions$') -and
                    ($names -match '^Manage Your Extensions$|^Tools for all add-ons$|^Add-ons Manager$'))
            }
            'about:config' {
                return [bool]($names -match '^Search preference name$|^Search preferences$|^Accept the Risk and Continue$')
            }
            default { return $false }
        }
    }
    function Is-InternalPage($root,[string]$page) {
        $expected='^'+[regex]::Escape($page)+'(?:[?#].*)?$'
        $addressMatch=$false
        $documentMatch=$false
        foreach ($item in (Elements $root)) {
            if ($item.Current.IsOffscreen) { continue }
            if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) {
                $value=Read-AccessibleValue $item
                if ($value -match $expected) { $documentMatch=$true }
                # A different committed document URL must never be overridden
                # by a matching draft in the address bar.
                elseif ($value -match '^(?:https?://|about:|file:|moz-extension:)') { return $false }
            } elseif (Is-AddressBar $item $root) {
                if ((Read-AccessibleValue $item) -match $expected) { $addressMatch=$true }
            }
        }
        return ($documentMatch -or $addressMatch) -and (Has-PageMarkers $root $page)
    }
    function Is-Addons($root) {
        return (Is-InternalPage $root 'about:addons') -and [bool](Find-Control $root 'Tools for all add-ons|Manage Your Extensions|Add-ons Manager|Extensions' @('ControlType.Button','ControlType.Text','ControlType.Hyperlink','ControlType.ListItem','ControlType.TabItem','ControlType.Document','ControlType.Group'))
    }
    $stage='verify selected Firefox executable'
    # Prefer the user's active Firefox executable, not a separate test profile.
    if (-not $FirefoxPath) {
        $running=@(Get-Process firefox -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
        $foreground=[QueueOptimizerFirefoxWindows]::GetForegroundWindow()
        $active=$running | Where-Object { $_.MainWindowHandle -eq $foreground } | Select-Object -First 1
        if ($active) { $FirefoxPath=$active.Path }
        if (-not $FirefoxPath) {
            $paths=@($running | ForEach-Object { $_.Path } | Where-Object { $_ } | Select-Object -Unique)
            if ($paths.Count -gt 1) { throw 'Multiple Firefox editions are running. Specify the desired executable with -FirefoxPath.' }
            if ($paths.Count -eq 1) { $FirefoxPath=$paths[0] }
        }
        if (-not $FirefoxPath) {
            $candidates=@()
            foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe','HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe')) {
                if (Test-Path -LiteralPath $key) { $candidates+=(Get-Item -LiteralPath $key).GetValue('') }
            }
            foreach ($root in @($env:ProgramFiles,${env:ProgramFiles(x86)},$env:LOCALAPPDATA)) {
                if ($root) { foreach ($edition in @('Mozilla Firefox','Firefox Developer Edition','Firefox Nightly','Mozilla Firefox ESR')) { $candidates+=Join-Path $root ($edition+'\firefox.exe') } }
            }
            $cmd=Get-Command firefox.exe -ErrorAction SilentlyContinue
            if ($cmd) { $candidates+=$cmd.Source }
            $FirefoxPath=$candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
        }
    }
    if (-not $FirefoxPath) { throw 'Firefox was not found. Install it or supply -FirefoxPath.' }
    $browser=(Resolve-Path -LiteralPath $FirefoxPath).ProviderPath
    if (-not (Test-Path -LiteralPath $browser -PathType Leaf) -or
        [Diagnostics.FileVersionInfo]::GetVersionInfo($browser).ProductName -notmatch 'Firefox') { throw 'Selected Firefox executable was not verified.' }
    function Pids {
        foreach ($p in @(Get-Process firefox -ErrorAction SilentlyContinue)) {
            try { if ($p.Path -and [string]::Equals($p.Path,$browser,[StringComparison]::OrdinalIgnoreCase)) { [uint32]$p.Id } } catch {}
        }
    }
    function Browser-Windows {
        foreach ($handle in [QueueOptimizerFirefoxWindows]::Windows([uint32[]]@(Pids),[IntPtr]::Zero)) {
            try { [System.Windows.Automation.AutomationElement]::FromHandle($handle) } catch {}
        }
    }
    $debugPage='about:debugging#/runtime/this-firefox'
    $firstPage=$debugPage
    # Pin one browser window/profile. Each internal page gets at most one
    # setup tab per invocation, and existing matching tabs can be reused.
    $nav=@{ window=$null; owner=[IntPtr]::Zero; processId=[uint32]0; page=''; transitions=0; openedTabs=0; tabs=@{}; launched=@{}; pageChecks=0; foregroundChecks=0; matchingWindows=0; adoptedInitialWindow=$false; requestedPage='' }
    function Dismiss-AddressPopup {
        if ([QueueOptimizerFirefoxWindows]::GetForegroundWindow() -ne $nav.owner) { return }
        $focused=[System.Windows.Automation.AutomationElement]::FocusedElement
        if ($focused -and (Is-AddressBar $focused $nav.window)) {
            [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
        }
    }
    function Refresh-SetupWindow {
        if ($nav.owner -eq [IntPtr]::Zero -or -not [QueueOptimizerFirefoxWindows]::IsWindow($nav.owner) -or
            [QueueOptimizerFirefoxWindows]::ProcessId($nav.owner) -ne $nav.processId) {
            throw 'The original Firefox setup window is no longer available.'
        }
        $nav.window=[System.Windows.Automation.AutomationElement]::FromHandle($nav.owner)
    }
    function Assert-SetupWindow {
        Refresh-SetupWindow
        $null=Wait-For 'foreground on original Firefox setup window' {
            if ([QueueOptimizerFirefoxWindows]::RecoverForeground($nav.owner)) { return $true }
        } 5
        Refresh-SetupWindow
    }
    function Get-BrowserTabs {
        $raw=[System.Windows.Automation.TreeWalker]::RawViewWalker
        foreach ($item in (Elements $nav.window)) {
            if ($item.Current.ControlType -ne [System.Windows.Automation.ControlType]::TabItem) { continue }
            $parent=$raw.GetParent($item)
            while ($parent) {
                if ($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { break }
                if ([System.Windows.Automation.Automation]::Compare($parent,$nav.window)) { $item; break }
                $parent=$raw.GetParent($parent)
            }
        }
    }
    function Tab-Key($tab) {
        try { return (($tab.GetRuntimeId()) -join ':') } catch { return '' }
    }
    function Selected-BrowserTab {
        foreach ($tab in (Get-BrowserTabs)) {
            $selection=$null
            if ($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$selection) -and $selection.Current.IsSelected) { return $tab }
        }
    }
    function Tab-TitleMatches($tab,[string]$base) {
        switch ($base) {
            'about:debugging' { return $tab.Current.Name -match '^Debugging(?:\s*[-\u2013\u2014].*)?$' }
            'about:addons' { return $tab.Current.Name -match '^Add-ons Manager(?:\s.*)?$|^Manage Your Extensions$' }
            'about:config' { return $tab.Current.Name -match '^Advanced Preferences(?:\s.*)?$|^about:config$|^Proceed with Caution$' }
            default { return $false }
        }
    }
    function Select-SetupTab($tab) {
        Assert-SetupWindow
        $selection=$null
        if ($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$selection)) {
            if (-not $selection.Current.IsSelected) { $selection.Select() }
        } else {
            Activate $tab
        }
    }
    function Wait-SetupPage([string]$base,[int]$seconds=25,[bool]$allowInitialRouting=$false) {
        $nav.requestedPage=$base
        $nav.matchingWindows=0
        $nextRecovery=[DateTime]::MinValue
        $recovery=@{ next=$nextRecovery }
        $null=Wait-For "original Firefox window displaying $base" {
            Refresh-SetupWindow
            $nav.pageChecks++
            $foreground=[QueueOptimizerFirefoxWindows]::GetForegroundWindow()
            if ($foreground -eq $nav.owner) {
                $nav.foregroundChecks++
                Dismiss-AddressPopup
            }
            # A committed internal page is evidence independently of Windows
            # foreground ownership. Do not couple read-only verification to
            # keyboard focus, which can be stolen during Firefox remote launch.
            if (Is-InternalPage $nav.window $base) { return $true }
            if ($allowInitialRouting -and $nav.transitions -eq 0) {
                # -new-tab is routed by Firefox to its most recent window.
                # Before the first verified transition only, adopt the unique
                # matching window in the same browser process. After that
                # point the original profile/window remains pinned.
                $matches=@(Browser-Windows | Where-Object {
                    $handle=[IntPtr]$_.Current.NativeWindowHandle
                    $handle -ne $nav.owner -and
                        [QueueOptimizerFirefoxWindows]::ProcessId($handle) -eq $nav.processId -and
                        (Is-InternalPage $_ $base)
                })
                $nav.matchingWindows=$matches.Count
                if ($matches.Count -eq 1) {
                    $nav.window=$matches[0]
                    $nav.owner=[IntPtr]$nav.window.Current.NativeWindowHandle
                    $nav.adoptedInitialWindow=$true
                    return $true
                }
            }
            # Throttle best-effort activation rather than requiring every
            # poll to observe foreground focus. Reacquire the UIA root on
            # the next poll even when activation is denied by Windows.
            if ($foreground -ne $nav.owner -and [DateTime]::UtcNow -ge $recovery.next) {
                $recovery.next=[DateTime]::UtcNow.AddSeconds(1)
                $null=[QueueOptimizerFirefoxWindows]::RecoverForeground($nav.owner)
            }
        } $seconds
    }
    function Remember-SetupTab([string]$base) {
        $selected=Selected-BrowserTab
        $key=''
        if ($selected) { $key=Tab-Key $selected }
        $nav.tabs[$base]=@{ key=$key }
        $nav.page=$base
        $nav.transitions++
    }
    function Navigate-Internal([string]$destination) {
        if ($destination -notin @('about:addons','about:config','about:debugging#/runtime/this-firefox')) {
            throw 'Unexpected Firefox setup destination.'
        }
        $base=$destination.Split('#')[0]
        if ($nav.owner -eq [IntPtr]::Zero) {
            $windows=@(Browser-Windows)
            if (-not $windows.Count) {
                # No browser exists: open a single initial window, then use
                # tabs in that same window for every remaining transition.
                Start-Process -FilePath $browser -ArgumentList @('-new-window',$destination) | Out-Null
                $first=Wait-For 'initial Firefox browser window' {
                    $candidates=@(Browser-Windows)
                    if ($candidates.Count -eq 1) { return $candidates[0] }
                } 40
                $nav.owner=[IntPtr]$first.Current.NativeWindowHandle
                $nav.processId=[QueueOptimizerFirefoxWindows]::ProcessId($nav.owner)
                $nav.launched[$base]=$true
                $nav.openedTabs++
                Assert-SetupWindow
                Wait-SetupPage $base 30 $true
                Remember-SetupTab $base
                return
            }
            $foreground=[QueueOptimizerFirefoxWindows]::GetForegroundWindow()
            $first=$windows | Where-Object { [IntPtr]$_.Current.NativeWindowHandle -eq $foreground } | Select-Object -First 1
            if (-not $first) { $first=$windows[0] }
            $nav.owner=[IntPtr]$first.Current.NativeWindowHandle
            $nav.processId=[QueueOptimizerFirefoxWindows]::ProcessId($nav.owner)
        }
        Assert-SetupWindow
        Dismiss-AddressPopup
        if (Is-InternalPage $nav.window $base) {
            Remember-SetupTab $base
            return
        }
        $tabs=@(Get-BrowserTabs)
        $target=$null
        if ($nav.tabs.ContainsKey($base) -and $nav.tabs[$base].key) {
            $target=$tabs | Where-Object { (Tab-Key $_) -eq $nav.tabs[$base].key } | Select-Object -First 1
        }
        if ($target) {
            Select-SetupTab $target
            Wait-SetupPage $base
            Remember-SetupTab $base
            return
        }
        # A browser restart or provider refresh can change runtime IDs.
        # Recover a uniquely named internal tab and verify its actual URL.
        $matches=@($tabs | Where-Object { Tab-TitleMatches $_ $base })
        # Previous runs may already have left duplicate setup tabs. Reuse
        # the first candidate whose committed page can actually be verified.
        # Do not close user tabs or create additional duplicates unnecessarily.
        foreach ($candidate in $matches) {
            Select-SetupTab $candidate
            try {
                Wait-SetupPage $base 5
                Remember-SetupTab $base
                return
            } catch [System.Windows.Automation.ElementNotAvailableException] {
                continue
            } catch {
                Assert-SetupWindow
            }
        }
        if ($nav.tabs.ContainsKey($base) -or $nav.launched.ContainsKey($base)) {
            throw "Previously opened Firefox setup tab for $base could not be recovered. No duplicate tab was opened."
        }
        # Let Firefox itself open the fixed privileged URL in a new tab;
        # never return to the unreliable Ctrl+L/omnibox automation.
        Assert-SetupWindow
        $nav.launched[$base]=$true
        $nav.openedTabs++
        Start-Process -FilePath $browser -ArgumentList @('-new-tab',$destination) | Out-Null
        Wait-SetupPage $base 30 ($nav.transitions -eq 0)
        Remember-SetupTab $base
    }
    function Allowed-Handles {
        @($nav.owner)+@([QueueOptimizerFirefoxWindows]::Windows([uint32[]]@(Pids),$nav.owner))
    }
    function Activate($item) {
        $fg=[QueueOptimizerFirefoxWindows]::GetForegroundWindow()
        if ((Allowed-Handles) -notcontains $fg) {
            Assert-SetupWindow
            $fg=[QueueOptimizerFirefoxWindows]::GetForegroundWindow()
        }
        if ((Allowed-Handles) -notcontains $fg) { throw 'Firefox lost foreground focus.' }
        if (-not $item -or -not $item.Current.IsEnabled) { throw 'Firefox control unavailable.' }
        if ($item.Current.IsOffscreen) {
            $scroll=$null
            if ($item.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern,[ref]$scroll)) {
                $scroll.ScrollIntoView()
            } else {
                try { $item.SetFocus() } catch {}
            }
            Start-Sleep -Milliseconds 250
        }
        if (-not (Visible $item)) { throw 'Firefox control could not be brought into view.' }
        $point=New-Object System.Windows.Point
        if ($item.TryGetClickablePoint([ref]$point)) {
            $hit=[System.Windows.Automation.AutomationElement]::FromPoint($point)
            for ($depth=0;$hit -and $depth -lt 10;$depth++) {
                if ([System.Windows.Automation.Automation]::Compare($hit,$item)) {
                    if ([QueueOptimizerFirefoxWindows]::Click($fg,[int]$point.X,[int]$point.Y)) { return }
                    break
                }
                $hit=[System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($hit)
            }
        }
        try { $item.SetFocus() } catch {}
        $focus=[System.Windows.Automation.AutomationElement]::FocusedElement
        if ($focus -and [System.Windows.Automation.Automation]::Compare($focus,$item) -and
            (Allowed-Handles) -contains [QueueOptimizerFirefoxWindows]::GetForegroundWindow()) {
            [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
            return
        }
        throw 'Firefox control could not be safely activated.'
    }
    function Wait-DebugPage {
        $null=Wait-For 'This Firefox extension inventory' {
            Dismiss-AddressPopup
            if (Is-InternalPage $nav.window 'about:debugging') { return $true }
        } 30
        # Allow asynchronous enumeration of installed extension targets.
        Start-Sleep -Milliseconds 750
    }
    function Find-DebugOptimizer {
        if (-not (Is-InternalPage $nav.window 'about:debugging')) { throw 'Firefox debugging page changed.' }
        $raw=[System.Windows.Automation.TreeWalker]::RawViewWalker
        $labels=@((Elements $nav.window) | Where-Object { $_.Current.Name -ceq 'ChatGPT Queue + Optimizer' })
        # The ChatGPT Queue Optimizer card can be well below the viewport. Its ID and
        # controls must be inspected even if UIA marks them offscreen.
        foreach ($label in $labels) {
            $parent=$label
            for ($depth=0;$parent -and $depth -lt 12;$depth++) {
                if ($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document -or
                    [System.Windows.Automation.Automation]::Compare($parent,$nav.window)) { break }
                $nodes=@(Elements $parent)
                $ids=@($nodes | Where-Object {
                    $_.Current.Name -ceq $addonId -or
                    $_.Current.Name -ceq ('Extension ID: '+$addonId)
                })
                # Do not accidentally scope an action to a container holding
                # multiple extension cards (including IDs without braces).
                $idLabels=@($nodes | Where-Object { $_.Current.Name -ceq 'Extension ID' })
                $inspect=@($nodes | Where-Object {
                    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
                    $_.Current.Name -ceq 'Inspect'
                })
                $remove=@($nodes | Where-Object {
                    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
                    $_.Current.Name -ceq 'Remove' -and $_.Current.IsEnabled
                })
                $reload=@($nodes | Where-Object {
                    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
                    $_.Current.Name -ceq 'Reload'
                })
                if ($idLabels.Count -gt 1 -or $inspect.Count -gt 1 -or $remove.Count -gt 1 -or $reload.Count -gt 1) { break }
                if ($ids.Count) {
                    if ($remove.Count -eq 1 -and $reload.Count -eq 1) {
                        # Firefox exposes the temporary extension's location in the debugging card.
                        # Check both decoded URI and native Windows path, including jar:file URLs.
                        $locationMatches=@($nodes | Where-Object {
                            $value=[string]$_.Current.Name
                            try { $value=[Uri]::UnescapeDataString($value) } catch {}
                            $value=$value.Replace('/','\')
                            $value.IndexOf($xpi,[StringComparison]::OrdinalIgnoreCase) -ge 0
                        })
                        return @{ temporary=$true; pathVerified=($locationMatches.Count -gt 0) }
                    }
                    if ($inspect.Count -eq 1) { return @{ temporary=$false } }
                }
                $parent=$raw.GetParent($parent)
            }
        }
        if ($labels.Count) { throw 'ChatGPT Queue Optimizer is listed but its exact Gecko ID and card controls could not be verified.' }
        # A pinned ID without a usable card is also not proof of absence.
        foreach ($node in (Elements $nav.window)) {
            if ($node.Current.Name -ceq $addonId -or
                $node.Current.Name -ceq ('Extension ID: '+$addonId)) {
                throw 'ChatGPT Queue Optimizer Gecko ID is listed but its extension card could not be verified.'
            }
        }
        return $null
    }
    $stage='open Firefox internal setup page'
    Navigate-Internal $firstPage
    Wait-DebugPage
    $previous=Find-DebugOptimizer
    # Let Firefox replace a temporary copy (or temporarily override a signed
    # copy) with the same Gecko ID. Never uninstall the existing add-on.
    function Resolve-InstallControl {
        $stage='locate Load Temporary Add-on on This Firefox'
        $item=Wait-For 'Load Temporary Add-on on the internal debugging page' {
            if (Is-InternalPage $nav.window 'about:debugging') {
                Find-Control $nav.window '^Load Temporary Add-on(?:\.{3}|\u2026)?$' @('ControlType.Button')
            }
        } 30
        return $item
    }
    function Is-VerifiedInstallControl($control) {
        if (-not $control -or -not (Visible $control) -or $control.Current.ProcessId -ne $nav.processId) { return $false }
        if (-not (Is-InternalPage $nav.window 'about:debugging') -or
            $control.Current.Name -notmatch '^Load Temporary Add-on(?:\.{3}|\u2026)?$') { return $false }
        $raw=[System.Windows.Automation.TreeWalker]::RawViewWalker
        $node=$control
        for ($depth=0;$node -and $depth -lt 60;$depth++) {
            if ([System.Windows.Automation.Automation]::Compare($node,$nav.window)) { return $true }
            $handle=[IntPtr]$node.Current.NativeWindowHandle
            if ($handle -ne [IntPtr]::Zero -and (Allowed-Handles) -contains $handle) { return $true }
            $node=$raw.GetParent($node)
        }
        return $false
    }
    $pickerDiagnostics=@{ dialogs=0; nativeEdit=$false; accessibleEdit=$false; method='none'; submitted=$false; focusRecovered=$false; invocation='none' }
    $stage='recover Firefox focus before selecting install control'
    Assert-SetupWindow
    $item=Resolve-InstallControl
    $stage='open Firefox XPI file picker'
    if ((Allowed-Handles) -notcontains [QueueOptimizerFirefoxWindows]::GetForegroundWindow()) {
        Assert-SetupWindow
        $pickerDiagnostics.focusRecovered=$true
        # Reopening/activating the window may dismiss a signed install menu.
        # Resolve the actual current control again rather than invoking stale UIA.
        $item=Resolve-InstallControl
    }
    if (-not (Is-VerifiedInstallControl $item)) { throw 'Firefox install control or current setup page could not be revalidated.' }
    $old=@([QueueOptimizerFirefoxWindows]::OwnedFileDialogs($nav.owner))
    # Some providers block Invoke until the modal closes. Keep the main
    # thread free to discover the native dialog, like the Chromium installer.
    $worker=$null
    $pending=$null
    $invoke=$null
    if ($item.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)) {
        # InvokePattern targets the verified UIA control, not the foreground
        # keyboard. A late focus change must not abort a safe direct invoke.
        # Native dialog ownership and exact filename are checked separately.
        $pickerDiagnostics.invocation='verified asynchronous UIA Invoke'
        $worker=[PowerShell]::Create()
        $null=$worker.AddScript({
            param($target)
            $ErrorActionPreference='Stop'
            $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        }.ToString()).AddArgument($item)
        $pending=$worker.BeginInvoke()
    } else {
        if ((Allowed-Handles) -notcontains [QueueOptimizerFirefoxWindows]::GetForegroundWindow()) {
            Assert-SetupWindow
            $item=Resolve-InstallControl
        }
        if (-not (Is-VerifiedInstallControl $item)) { throw 'Firefox install control changed before activation.' }
        $pickerDiagnostics.invocation='verified foreground activation'
        Activate $item
    }
    $stage='select XPI in Firefox file picker'
    try {
        $picker=Wait-For 'new Firefox-owned Windows file picker' {
            $handles=@([QueueOptimizerFirefoxWindows]::OwnedFileDialogs($nav.owner) | Where-Object {
                $old -notcontains $_ -and [QueueOptimizerFirefoxWindows]::IsFileDialog($_,$nav.owner)
            })
            $pickerDiagnostics.dialogs=$handles.Count
            if ($handles.Count -eq 1) { return $handles[0] }
            if ($handles.Count -gt 1) { throw 'Multiple new Firefox-owned dialogs; refusing ambiguous file selection.' }
            if ($pending -and $pending.IsCompleted -and $worker.HadErrors) { throw 'Firefox file picker invocation failed.' }
        } 30
        $null=Wait-For 'foreground focus on verified Firefox file picker' {
            if ([QueueOptimizerFirefoxWindows]::IsFileDialog($picker,$nav.owner) -and
                [QueueOptimizerFirefoxWindows]::RecoverForeground($picker)) { return $true }
        } 5
        $stage='enter exact XPI path'
        $nativeEdit=[QueueOptimizerFirefoxWindows]::FileNameEdit($picker)
        if ($nativeEdit -ne [IntPtr]::Zero) {
            $pickerDiagnostics.nativeEdit=$true
            $pickerDiagnostics.method='native filename control'
            if (-not [QueueOptimizerFirefoxWindows]::SetFileName($picker,$nav.owner,$xpi)) {
                throw 'Native File name control did not retain the exact XPI path.'
            }
        } else {
            $root=[System.Windows.Automation.AutomationElement]::FromHandle($picker)
            $field=Find-Control $root '^File name:?\s*$' @('ControlType.Edit','ControlType.ComboBox')
            if (-not $field) {
                foreach ($candidate in (Elements $root)) {
                    if ((Visible $candidate) -and $candidate.Current.AutomationId -in @('1148','1152') -and
                        $candidate.Current.ControlType.ProgrammaticName -in @('ControlType.Edit','ControlType.ComboBox')) { $field=$candidate; break }
                }
            }
            if (-not $field) { throw 'Verified Windows file picker exposes neither native nor accessible File name control.' }
            $value=$null
            if (-not $field.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$value)) {
                $field=Find-Control $field '.*' @('ControlType.Edit')
                if (-not $field -or -not $field.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$value)) { throw 'File name control does not expose its value.' }
            }
            $pickerDiagnostics.accessibleEdit=$true
            $pickerDiagnostics.method='accessible filename control'
            if ([QueueOptimizerFirefoxWindows]::GetForegroundWindow() -ne $picker -or -not [QueueOptimizerFirefoxWindows]::IsFileDialog($picker,$nav.owner)) { throw 'File picker lost focus.' }
            $value.SetValue($xpi)
            if (-not [string]::Equals($value.Current.Value,$xpi,[StringComparison]::OrdinalIgnoreCase)) { throw 'File picker did not retain the exact XPI path.' }
        }
        $stage='submit Firefox XPI file picker'
        if (-not [QueueOptimizerFirefoxWindows]::SubmitFileDialog($picker,$nav.owner)) { throw 'Verified file picker Open button could not be activated.' }
        $pickerDiagnostics.submitted=$true
        $null=Wait-For 'Firefox file picker to close' {
            if (-not [QueueOptimizerFirefoxWindows]::IsWindow($picker)) { return $true }
        } 20
        if ($pending -and $pending.IsCompleted) { $null=$worker.EndInvoke($pending) }
    } finally {
        if ($worker -and $pending -and $pending.IsCompleted) { $worker.Dispose() }
    }
    $stage='verify temporary ChatGPT Queue Optimizer extension'
    $null=Wait-For 'temporary add-on with the pinned Gecko ID' {
        if (Is-InternalPage $nav.window 'about:debugging') {
            $target=Find-DebugOptimizer
            if ($target -and $target.temporary -and ($target.pathVerified -or -not ($previous -and $previous.temporary))) { return $true }
        }
    } 30
    Write-Output "ChatGPT Queue + Optimizer temporary add-on is present in the opened Firefox profile (selected XPI version $version). Run this installer again after restarting Firefox."
    exit 0
} catch {
    [Console]::Error.WriteLine(('Firefox setup stage: {0}. {1}' -f $stage,$_.Exception.Message))
    if ($nav) {
        [Console]::Error.WriteLine(('Firefox navigation: verified page={0}; transitions={1}; new setup tabs={2}; foreground={3}; requested page={4}; page checks={5}; foreground checks={6}; other matching windows={7}; initial window adopted={8}.' -f $nav.page,$nav.transitions,$nav.openedTabs,([QueueOptimizerFirefoxWindows]::GetForegroundWindow() -eq $nav.owner),$nav.requestedPage,$nav.pageChecks,$nav.foregroundChecks,$nav.matchingWindows,$nav.adoptedInitialWindow))
    }
    if ($pickerDiagnostics) {
        [Console]::Error.WriteLine(('Firefox file picker: new owned dialogs={0}; native filename={1}; accessible filename={2}; method={3}; submitted={4}; focus recovered={5}; invocation={6}.' -f $pickerDiagnostics.dialogs,$pickerDiagnostics.nativeEdit,$pickerDiagnostics.accessibleEdit,$pickerDiagnostics.method,$pickerDiagnostics.submitted,$pickerDiagnostics.focusRecovered,$pickerDiagnostics.invocation))
    }
    exit 1
}
