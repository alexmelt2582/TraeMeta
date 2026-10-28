import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Extracts the SQLCipher key for Trae CN's chat database out of the running
 * client's memory.
 *
 * The key exists nowhere on disk — the client holds the 64-hex-char string in
 * its heap for the lifetime of the database connection. Finding it means
 * enumerating the committed readable regions of processes whose executable path
 * matches the configured Trae CN install, sliding a 64-hex-char window over
 * every region, and validating each candidate against the database's page-1
 * HMAC (the same oracle `trae-session-cipher.js` uses).
 *
 * Node has no ReadProcessMemory, so the scan runs as a generated PowerShell
 * script with an embedded C# worker. Constraints that are load-bearing:
 *   - the script text is pure ASCII (Chinese wording lives in this module);
 *   - paths travel as spawn arguments (UTF-16 safe), never inside the script;
 *   - the key only ever appears in stdout, which this module reduces to a
 *     return value — it must not be logged by any caller.
 */

const SCRIPT_HEADER = `param(
    [string]$TraeExe,
    [string]$DbPath,
    [int]$MaxProcs = 12
)

$ErrorActionPreference = 'Stop'

function Write-Result([hashtable]$Result) {
    $Result | ConvertTo-Json -Compress -Depth 3 | Write-Output
}

if (-not (Test-Path -LiteralPath $DbPath)) {
    Write-Result @{ found = $false; code = 'db-unreadable' }
    exit 0
}
$dbFile = New-Object System.IO.FileStream($DbPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
$page1 = New-Object byte[] 4096
try {
    $read = $dbFile.Read($page1, 0, 4096)
    if ($read -lt 4096) {
        Write-Result @{ found = $false; code = 'db-unreadable' }
        exit 0
    }
} finally {
    $dbFile.Dispose()
}

$procList = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='Trae CN.exe'" -ErrorAction SilentlyContinue)
if ($procList.Count -eq 0) {
    Write-Result @{ found = $false; code = 'no-process' }
    exit 0
}
$matched = @($procList | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $TraeExe })
if ($matched.Count -eq 0) {
    Write-Result @{ found = $false; code = 'no-matching-process'; seen = $procList.Count }
    exit 0
}
$targets = @($matched | Sort-Object -Property WorkingSetSize -Descending)

# The database connection lives in the process that hosts the ai-agent module.
# Working-set order alone is a guess across ~30 client processes; module presence
# is the reliable ranking, with the rest kept as fallback.
$withModule = @()
$other = @()
foreach ($p in $targets) {
    $hasAi = $false
    try {
        foreach ($m in (Get-Process -Id $p.ProcessId -ErrorAction Stop).Modules) {
            if ($m.ModuleName -like '*ai_agent*') { $hasAi = $true; break }
        }
    } catch {
        # Access-denied or exited between listing and probing: keep as fallback.
    }
    if ($hasAi) { $withModule += $p } else { $other += $p }
}
$ordered = @($withModule + $other)
if ($ordered.Count -gt $MaxProcs) {
    $ordered = @($ordered | Select-Object -First $MaxProcs)
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace TraeMeta {
    public static class KeyScan {
        [StructLayout(LayoutKind.Sequential)]
        private struct MEMORY_BASIC_INFORMATION {
            public IntPtr BaseAddress;
            public IntPtr AllocationBase;
            public uint AllocationProtect;
            public IntPtr RegionSize;
            public uint State;
            public uint Protect;
            public uint Type;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ReadProcessMemory(IntPtr process, IntPtr baseAddress,
            byte[] buffer, IntPtr size, out IntPtr read);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr VirtualQueryEx(IntPtr process, IntPtr address,
            out MEMORY_BASIC_INFORMATION info, IntPtr length);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        private const uint MEM_COMMIT = 0x1000;
        private const int PAGE_SIZE = 4096;

        private static bool IsHex(byte b) {
            return (b >= 48 && b <= 57) || (b >= 97 && b <= 102) || (b >= 65 && b <= 70);
        }

        // PBKDF2-HMAC-SHA512 with two iterations and a 32-byte block, inlined so
        // the script does not depend on a .NET version that knows Rfc2898DeriveBytes.
        private static byte[] MacKey(byte[] key, byte[] pageSalt) {
            var macSalt = new byte[20]; // 16-byte salt followed by big-endian INT(1)
            for (int i = 0; i < 16; i++) macSalt[i] = (byte)(pageSalt[i] ^ 0x3a);
            macSalt[19] = 1;
            using (var hmac = new System.Security.Cryptography.HMACSHA512(key)) {
                byte[] u1 = hmac.ComputeHash(macSalt);
                byte[] u2 = hmac.ComputeHash(u1);
                var block = new byte[32];
                for (int i = 0; i < 32; i++) block[i] = (byte)(u1[i] ^ u2[i]);
                return block;
            }
        }

        private static bool VerifyKey(byte[] key, byte[] page1) {
            if (key.Length != 32) return false;
            byte[] macKey = MacKey(key, page1);
            var data = new byte[4016 + 4];
            Buffer.BlockCopy(page1, 16, data, 0, 4016);
            data[4016] = 1; // little-endian page number 1
            using (var hmac = new System.Security.Cryptography.HMACSHA512(macKey)) {
                byte[] digest = hmac.ComputeHash(data);
                for (int i = 0; i < 64; i++) {
                    if (digest[i] != page1[4032 + i]) return false;
                }
            }
            return true;
        }

        private static byte[] HexToBytes(byte[] data, int offset) {
            var key = new byte[32];
            for (int i = 0; i < 32; i++) {
                int hi = data[offset + i * 2];
                int lo = data[offset + i * 2 + 1];
                hi = hi <= 57 ? hi - 48 : (hi <= 102 ? hi - 87 : hi - 55);
                lo = lo <= 57 ? lo - 48 : (lo <= 102 ? lo - 87 : lo - 55);
                key[i] = (byte)((hi << 4) | lo);
            }
            return key;
        }

        private static string ScanRegion(byte[] data, byte[] page1) {
            int n = data.Length;
            int i = 0;
            while (i + 64 <= n) {
                bool allHex = true;
                for (int k = 0; k < 64; k++) {
                    if (!IsHex(data[i + k])) { allHex = false; break; }
                }
                if (!allHex) { i++; continue; }
                if (VerifyKey(HexToBytes(data, i), page1)) {
                    char[] chars = new char[64];
                    for (int k = 0; k < 64; k++) chars[k] = (char)data[i + k];
                    return new string(chars).ToLowerInvariant();
                }
                i++;
            }
            return null;
        }

        public static string Scan(int pid, byte[] page1) {
            IntPtr handle = OpenProcess(0x0410, false, pid);
            if (handle == IntPtr.Zero) return null;
            try {
                long address = 0;
                while (address < 0x7FFFFFFEFFFF) {
                    MEMORY_BASIC_INFORMATION info;
                    IntPtr ret = VirtualQueryEx(handle, (IntPtr)address, out info,
                        (IntPtr)Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION)));
                    if (ret == IntPtr.Zero) break;
                    long size = info.RegionSize.ToInt64();
                    long next = info.BaseAddress.ToInt64() + size;
                    if (next <= address) break;
                    address = next;
                    if (info.State != MEM_COMMIT || size <= 0 || size >= 500L * 1024 * 1024) continue;
                    int protect = (int)info.Protect;
                    bool readable = protect == 0x02 || protect == 0x04 || protect == 0x08
                        || protect == 0x10 || protect == 0x20 || protect == 0x40 || protect == 0x80;
                    if (!readable) continue;
                    var buffer = new byte[size];
                    IntPtr read;
                    if (!ReadProcessMemory(handle, info.BaseAddress, buffer, (IntPtr)size, out read)) continue;
                    int length = (int)read;
                    if (length < 64) continue;
                    string found = ScanRegion(buffer, page1);
                    if (found != null) return found;
                }
            } finally {
                CloseHandle(handle);
            }
            return null;
        }
    }
}
'@

$page1Field = [byte[]]$page1
foreach ($proc in $targets) {
    $key = [TraeMeta.KeyScan]::Scan([int]$proc.ProcessId, $page1Field)
    if ($key) {
        Write-Result @{ found = $true; key = $key; pid = [int]$proc.ProcessId }
        exit 0
    }
}
Write-Result @{ found = $false; code = 'not-found'; tried = $targets.Count }
`;

let scriptPromise = null;

function scriptPath() {
  if (!scriptPromise) {
    const file = path.join(os.tmpdir(), "traemeta-session-scan.ps1");
    scriptPromise = fs
      .writeFile(file, SCRIPT_HEADER, "utf8")
      .then(() => file)
      .catch((error) => {
        scriptPromise = null;
        throw error;
      });
  }
  return scriptPromise;
}

function describeFailure(code, stderrTail) {
  switch (code) {
    case "db-unreadable":
      return "无法读取 TRAE 会话库文件，请确认 TRAE 已登录并重试";
    case "no-process":
      return "未检测到运行中的 TRAE，请先启动并登录 TRAE 后再试";
    case "no-matching-process":
      return "检测到 TRAE 进程，但路径与助手配置的不一致；请用 TraeMeta.exe configure --trae-exe 校正后重试";
    case "not-found":
      return "未能从 TRAE 进程内存中提取会话库密钥，请确认 TRAE 已登录，稍等几秒后重试";
    default:
      return `会话库密钥扫描失败${stderrTail ? `：${stderrTail}` : ""}`;
  }
}

/**
 * Runs the memory scan and resolves to `{ ok: true, keyHex, pid, elapsedMs }`
 * or `{ ok: false, message }`. The resolved value never carries anything but
 * the key — callers must keep it in memory and out of logs.
 */
export async function scanTraeSessionKey({ traeExe, dbPath, timeoutMs = 180_000 }) {
  const file = await scriptPath();
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        file,
        "-TraeExe",
        String(traeExe),
        "-DbPath",
        String(dbPath),
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, message: "会话库密钥扫描超时，请重试" });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, message: `无法启动会话库密钥扫描：${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - startedAt;
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
      let parsed = null;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const value = JSON.parse(lines[i]);
          if (value && typeof value === "object" && "found" in value) {
            parsed = value;
            break;
          }
        } catch {
          // not the result line; keep looking upwards
        }
      }
      if (parsed?.found && typeof parsed.key === "string") {
        resolve({ ok: true, keyHex: parsed.key, pid: parsed.pid ?? null, elapsedMs });
        return;
      }
      if (parsed?.code) {
        resolve({
          ok: false,
          code: parsed.code,
          message: describeFailure(parsed.code, ""),
          elapsedMs,
        });
        return;
      }
      const tail = stderr.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      resolve({
        ok: false,
        message: describeFailure(code === 0 ? "not-found" : "internal", tail),
        elapsedMs,
      });
    });
  });
}
