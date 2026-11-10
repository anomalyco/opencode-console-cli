# Installs the OpenCode Console CLI on Windows without Node: downloads the opencode-console binary for this computer from
# Anomaly's release service, checks its size and SHA-256 and, for a stable or beta release, its Authenticode signature
# (Anomaly's Artifact Signing certificate),
# runs its self-test, then hands over to it. Its `setup` installs it where agents run it, connects the agent and keeps
# it up to date. To be served at https://opencode.ai/console/install.ps1; the PowerShell twin of ./install. Ported from
# anomalyco/browse's install.ps1 (2b6194cf).
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/anomalyco/opencode-console-cli/production/install.ps1))) setup claude-code
#
# Options: --version <version> (from npm, or $env:OPENCODE_CONSOLE_VERSION), --channel <stable|beta|dev>. Everything
# else goes to opencode-console.

function Install-OpenCodeConsole {
    param([string[]]$Arguments)
    Set-StrictMode -Off
    # Everything runs in this function so a failure stops it without closing the window `irm | iex` runs in.
    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"

    $version = $env:OPENCODE_CONSOLE_VERSION
    $channel = "stable"
    $rest = @()
    for ($i = 0; $i -lt $Arguments.Count; $i++) {
        $arg = [string]$Arguments[$i]
        switch -Regex ($arg) {
            "^(-h|--help)$" {
                Write-Host "Usage: install.ps1 [--version <version>] [--channel stable|beta|dev] setup <claude-code|pi|codex|deepseek-harness|hermes> [setup options]"
                return
            }
            "^(-v|--version)$" {
                if ($i + 1 -ge $Arguments.Count) { throw "--version requires a version" }
                $version = [string]$Arguments[++$i]
                continue
            }
            "^--channel$" {
                if ($i + 1 -ge $Arguments.Count) { throw "--channel requires a channel" }
                $channel = [string]$Arguments[++$i]
                continue
            }
            default { $rest += $arg }
        }
    }
    if ($channel -eq "latest") { $channel = "stable" }
    if ($channel -notin @("stable", "beta", "dev")) { throw "unknown channel $channel (stable, beta or dev)" }
    if ($version) {
        $version = $version -replace "^v", ""
        if ($version -notmatch '^\d+\.\d+\.\d+(-(dev|beta)\.\d+(\.\d+)?)?$') { throw "$version isn't a release version" }
        # A pinned version's own channel decides its checks, whatever --channel said.
        $channel = if ($version -match "-dev\.") { "dev" } elseif ($version -match "-beta\.") { "beta" } else { "stable" }
    }

    # Windows PowerShell 5.1 may still default to TLS 1.0, which the npm registry refuses.
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

    $service = if ($env:OPENCODE_CONSOLE_RELEASE_SERVICE) { $env:OPENCODE_CONSOLE_RELEASE_SERVICE.TrimEnd("/") } else { "https://anoma.ly/release" }
    if ($service -ne "https://anoma.ly/release") {
        if ($service -notmatch "^http://(127\.0\.0\.1|localhost):\d+/release$") { throw "OPENCODE_CONSOLE_RELEASE_SERVICE must be https://anoma.ly/release, not $service" }
        if ($channel -ne "dev") { throw "a release service on this computer serves dev builds only" }
    }

    $arch = $null
    try { $arch = [string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture } catch {}
    if (-not $arch) { $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE } }
    $target = switch -Regex ($arch) {
        "^(X64|AMD64)$" { "windows-x64" }
        # Windows on ARM runs the x64 build under emulation; the baseline build doesn't need AVX2.
        "^(Arm64|ARM64)$" { "windows-x64-baseline" }
        default { throw "No binary for $arch; run npx @opencode/console setup <agent> with Node instead." }
    }
    if ($target -eq "windows-x64") {
        $avx2 = $false
        try {
            $avx2 = (Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)
        } catch {}
        if (-not $avx2) { $target = "windows-x64-baseline" }
    }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) "opencode-console-install-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $archive = Join-Path $tmp "opencode-console.tgz"
    $releaseSha = $null
    try {
        if ($version) {
            # A pinned version comes from npm: the release service serves one current release per channel.
            $package = "@opencode/console-$target"
            $metadata = Invoke-RestMethod -UseBasicParsing "https://registry.npmjs.org/@opencode%2fconsole-$target/$version"
            $sri = [regex]::Match([string]$metadata.dist.integrity, '(?:^|\s)sha512-([A-Za-z0-9+/]+={0,2})(?:\s|$)')
            if (-not $sri.Success) { throw "$package@$version has no SHA-512 integrity; nothing was installed" }
            $expected = ([BitConverter]::ToString([Convert]::FromBase64String($sri.Groups[1].Value)) -replace "-", "").ToLowerInvariant()
            $tarball = [string]$metadata.dist.tarball
            if (-not $tarball.StartsWith("https://registry.npmjs.org/")) { throw "$package@$version's tarball isn't on registry.npmjs.org" }
            Write-Host "Downloading opencode-console $version ($target, from npm)"
            Invoke-WebRequest -UseBasicParsing -Uri $tarball -OutFile $archive
            if ((Get-FileHash -Algorithm SHA512 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $expected) {
                throw "checksum mismatch for $package@$version; nothing was installed"
            }
        } else {
            # PowerShell 7 validates the User-Agent as RFC 7231 product tokens, so the channel lives in a comment.
            $manifest = Invoke-RestMethod -UseBasicParsing -UserAgent "opencode-console/$channel (install)" "$service/opencode-console/cli/$channel.json"
            if ($manifest.app -ne "opencode-console" -or $manifest.artifact -ne "cli" -or $manifest.channel -ne $channel) {
                throw "$service/opencode-console/cli/$channel.json isn't the CLI's $channel manifest"
            }
            $version = [string]$manifest.release.version
            $entry = $manifest.release.targets.PSObject.Properties[$target]
            if (-not $entry) { throw "the $channel release has no $target build; run npx @opencode/console setup <agent> instead" }
            $url = [string]$entry.Value.url
            if ($url -notmatch "^/[^/\\]") { throw "unexpected download URL $url" }
            $url = ($service -replace "/release$", "") + $url
            $releaseSha = ([string]$entry.Value.sha256).ToLowerInvariant()
            Write-Host "Downloading opencode-console $version ($target, $channel)"
            Invoke-WebRequest -UseBasicParsing -UserAgent "opencode-console/$version ($channel; cli)" -Uri $url -OutFile $archive
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $releaseSha) {
                throw "checksum mismatch for $(Split-Path $url -Leaf); nothing was installed"
            }
            if ((Get-Item -LiteralPath $archive).Length -ne [long]$entry.Value.size) {
                throw "size mismatch for $(Split-Path $url -Leaf); nothing was installed"
            }
        }

        # Windows 10 and later ship bsdtar as System32\tar.exe; another tar on PATH (Git's) can't read C:\ paths.
        $tar = Join-Path $env:SystemRoot "System32\tar.exe"
        if (-not (Test-Path -LiteralPath $tar)) { throw "Windows' tar.exe is required" }
        # Only the binary: a DLL beside it would load into its self-test.
        & $tar -xzf $archive -C $tmp package/bin/opencode-console.exe
        if ($LASTEXITCODE -ne 0) { throw "the download has no package\bin\opencode-console.exe" }
        $binary = Join-Path $tmp "package\bin\opencode-console.exe"
        $item = Get-Item -LiteralPath $binary
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "the download's opencode-console.exe isn't a file" }

        # Before anything from the download runs. Dev builds aren't signed. A stable or beta binary must carry a valid,
        # timestamped Authenticode signature by Anomaly's Artifact Signing certificate, as Hex's updater requires.
        if ($channel -ne "dev") {
            $signature = Get-AuthenticodeSignature -LiteralPath $binary
            if ($signature.Status -ne "Valid" -or -not $signature.TimeStamperCertificate) {
                throw "opencode-console $version isn't validly signed ($($signature.Status)); nothing was installed"
            }
            $signer = $signature.SignerCertificate.GetNameInfo('SimpleName', $false)
            if ($signer -ne "Anomaly Innovations, Inc https://anoma.ly/") {
                throw "opencode-console $version is signed by $signer, not Anomaly; nothing was installed"
            }
        }
        & $binary self-test | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "opencode-console $version failed its self-test on this computer; nothing was installed" }

        if ($rest.Count -eq 0) {
            Write-Host "opencode-console $version checks out. Connect an agent with:"
            Write-Host "  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/anomalyco/opencode-console-cli/production/install.ps1))) setup claude-code"
            return
        }
        if ($releaseSha) { $env:OPENCODE_CONSOLE_RELEASE_SHA256 = $releaseSha }
        & $binary @rest
        $global:LASTEXITCODE = $LASTEXITCODE
    } finally {
        Remove-Item Env:OPENCODE_CONSOLE_RELEASE_SHA256 -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

try {
    Install-OpenCodeConsole -Arguments $args
} catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    $global:LASTEXITCODE = 1
}
