# Checks the Authenticode signatures CI applied through Azure Artifact Signing to every executable in the given
# folders. Ported from anomalyco/hex (.github/release/verify-authenticode.ps1, a65a5e37).
#
#   .github/release/verify-authenticode.ps1 -Folders work/sign
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string[]]$Folders
)
$ErrorActionPreference = 'Stop'

$files = @($Folders | ForEach-Object { Get-ChildItem -LiteralPath $_ | Where-Object Extension -eq '.exe' })
if ($files.Count -eq 0) { throw "No executables in $($Folders -join ', ')." }
foreach ($file in $files) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid') {
        throw "$($file.Name) is not validly signed: $($signature.Status) $($signature.StatusMessage)"
    }
    # Artifact Signing certificates last days; only the timestamp keeps the signature valid afterwards.
    if (-not $signature.TimeStamperCertificate) { throw "$($file.Name) has no RFC 3161 timestamp." }
    # The signer the updater and install.ps1 require (src/update/signature.ts WINDOWS_SIGNER).
    $signer = $signature.SignerCertificate.GetNameInfo('SimpleName', $false)
    if ($signer -ne "Anomaly Innovations, Inc https://anoma.ly/") { throw "$($file.Name) is signed by $signer, not Anomaly." }
    Write-Output "ok - $($file.Name) signed by $($signature.SignerCertificate.Subject)"
}
