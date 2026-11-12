# Signs every executable in a folder with a throwaway self-signed code signing certificate, for a check run, which has
# no Azure sign-in: the binaries still take the signed path to repack and every publish step's dry run, and each
# signature is read back as the throwaway certificate's over the file's current bytes. The certificate is removed
# afterwards. Windows PowerShell 5.1, whose PKI module makes the certificate.
#
#   .github/release/sign-windows-dry.ps1 -Folder work/sign
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$Folder
)
$ErrorActionPreference = 'Stop'

$files = @(Get-ChildItem -LiteralPath $Folder | Where-Object Extension -eq '.exe')
if ($files.Count -eq 0) { throw "No executables in $Folder." }
$certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=OpenCode Console CLI check run (throwaway)' `
    -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(1)
try {
    foreach ($file in $files) {
        $null = Set-AuthenticodeSignature -LiteralPath $file.FullName -Certificate $certificate -HashAlgorithm SHA256
        $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
        # The throwaway root isn't trusted, so a good signature reads UnknownError, not Valid.
        if ($signature.Status -eq 'NotSigned' -or $signature.Status -eq 'HashMismatch') {
            throw "$($file.Name) didn't sign: $($signature.Status) $($signature.StatusMessage)"
        }
        if ($signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
            throw "$($file.Name) is signed by $($signature.SignerCertificate.Subject), not the throwaway certificate."
        }
        Write-Output "dry run - $($file.Name) signed with a throwaway certificate"
    }
} finally {
    Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -DeleteKey
}
