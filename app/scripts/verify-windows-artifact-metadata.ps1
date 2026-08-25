param(
  [Parameter(Mandatory = $true)]
  [string]$MainExecutable,
  [Parameter(Mandatory = $true)]
  [string]$InstallerExecutable,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,
  [string]$UninstallerExecutable = "",
  [Parameter(Mandatory = $true)]
  [string]$IconPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Drawing

function Assert-File([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label 不存在"
  }
}

function Get-IconPixelSha256([string]$Executable, [string]$SourceIcon) {
  $embeddedIcon = [Drawing.Icon]::ExtractAssociatedIcon($Executable)
  if ($null -eq $embeddedIcon) {
    throw "无法读取嵌入图标"
  }
  $referenceIcon = $null
  $embeddedBitmap = $null
  $referenceBitmap = $null
  $sha256 = $null
  try {
    # 使用相同尺寸逐像素比较，避免 ICO 容器元数据差异造成假阴性。
    $referenceIcon = [Drawing.Icon]::new($SourceIcon, $embeddedIcon.Size)
    $embeddedBitmap = $embeddedIcon.ToBitmap()
    $referenceBitmap = $referenceIcon.ToBitmap()
    if (
      $embeddedBitmap.Width -ne $referenceBitmap.Width -or
      $embeddedBitmap.Height -ne $referenceBitmap.Height
    ) {
      throw "嵌入图标尺寸与品牌图标不一致"
    }
    $bytes = [byte[]]::new($embeddedBitmap.Width * $embeddedBitmap.Height * 4)
    $offset = 0
    for ($y = 0; $y -lt $embeddedBitmap.Height; $y++) {
      for ($x = 0; $x -lt $embeddedBitmap.Width; $x++) {
        $embeddedArgb = $embeddedBitmap.GetPixel($x, $y).ToArgb()
        $referenceArgb = $referenceBitmap.GetPixel($x, $y).ToArgb()
        if ($embeddedArgb -ne $referenceArgb) {
          throw "嵌入图标像素与品牌图标不一致"
        }
        [BitConverter]::GetBytes($embeddedArgb).CopyTo($bytes, $offset)
        $offset += 4
      }
    }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    return [Convert]::ToHexString($sha256.ComputeHash($bytes)).ToLowerInvariant()
  } finally {
    if ($null -ne $sha256) { $sha256.Dispose() }
    if ($null -ne $referenceBitmap) { $referenceBitmap.Dispose() }
    if ($null -ne $embeddedBitmap) { $embeddedBitmap.Dispose() }
    if ($null -ne $referenceIcon) { $referenceIcon.Dispose() }
    $embeddedIcon.Dispose()
  }
}

function ConvertTo-WindowsVersion([string]$SemVer) {
  $semVerPattern = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9][0-9]*|(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*)))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$'
  if ($SemVer -notmatch $semVerPattern) {
    throw "ExpectedVersion 不是有效 SemVer"
  }
  $major = $Matches[1]
  $minor = $Matches[2]
  $patch = $Matches[3]
  # 主程序 ProductVersion 遵循 electron-builder 的 Windows 四段格式，仍只从 package.json.version 推导。
  return "$major.$minor.$patch.0"
}

$expectedWindowsProductVersion = ConvertTo-WindowsVersion $ExpectedVersion

function Assert-Version([string]$Value, [string]$Expected, [string]$Label) {
  if ($Value -cne $Expected) {
    throw "$Label 版本不符合 $Expected"
  }
}

foreach ($entry in @(
  @{ Path = $MainExecutable; Label = "Windows 主程序" },
  @{ Path = $InstallerExecutable; Label = "NSIS 安装器" },
  @{ Path = $IconPath; Label = "品牌 ICO" }
)) {
  Assert-File $entry.Path $entry.Label
}
if (-not [string]::IsNullOrWhiteSpace($UninstallerExecutable)) {
  Assert-File $UninstallerExecutable "NSIS 卸载器"
}

$mainInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($MainExecutable)
$expectedMainStrings = [ordered]@{
  ProductName = "天将漫创"
  FileDescription = "天将漫创"
  InternalName = "天将漫创"
  CompanyName = "HBAI-Ltd"
}
foreach ($property in $expectedMainStrings.Keys) {
  if ([string]$mainInfo.$property -ne $expectedMainStrings[$property]) {
    throw "Windows 主程序 $property 不符合发布契约"
  }
}
# electron-builder 原生 signAndEditResources 明确把 OriginalFilename 写为空值。
if (-not [string]::IsNullOrEmpty([string]$mainInfo.OriginalFilename)) {
  throw "Windows 主程序 OriginalFilename 未遵循 electron-builder 原生资源合同"
}
Assert-Version $mainInfo.FileVersion $ExpectedVersion "Windows 主程序 FileVersion"
Assert-Version $mainInfo.ProductVersion $expectedWindowsProductVersion "Windows 主程序 ProductVersion"

$installerInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($InstallerExecutable)
Assert-Version $installerInfo.FileVersion $ExpectedVersion "NSIS 安装器 FileVersion"
Assert-Version $installerInfo.ProductVersion $ExpectedVersion "NSIS 安装器 ProductVersion"
if ((Split-Path -Leaf $InstallerExecutable) -ne "天将漫创-$ExpectedVersion-win-x64-setup.exe") {
  throw "NSIS 安装器文件名不符合发布契约"
}

$mainIconSha256 = Get-IconPixelSha256 $MainExecutable $IconPath
$installerIconSha256 = Get-IconPixelSha256 $InstallerExecutable $IconPath

$mainSignature = (Get-AuthenticodeSignature -LiteralPath $MainExecutable).Status.ToString()
$installerSignature = (Get-AuthenticodeSignature -LiteralPath $InstallerExecutable).Status.ToString()
if ($mainSignature -ne "NotSigned") {
  throw "Windows 主程序必须明确未签名：$mainSignature"
}
if ($installerSignature -ne "NotSigned") {
  throw "NSIS 安装器必须明确未签名：$installerSignature"
}
$uninstallerEvidence = [ordered]@{
  signatureStatus = "NotInspected"
}
if (-not [string]::IsNullOrWhiteSpace($UninstallerExecutable)) {
  $uninstallerInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($UninstallerExecutable)
  Assert-Version $uninstallerInfo.FileVersion $ExpectedVersion "NSIS 卸载器 FileVersion"
  Assert-Version $uninstallerInfo.ProductVersion $ExpectedVersion "NSIS 卸载器 ProductVersion"
  $uninstallerSignature = (
    Get-AuthenticodeSignature -LiteralPath $UninstallerExecutable
  ).Status.ToString()
  if ($uninstallerSignature -ne "NotSigned") {
    throw "NSIS 卸载器必须明确未签名：$uninstallerSignature"
  }
  # 真实安装后卸载器必须同时满足品牌图标和明确未签名状态。
  $null = Get-IconPixelSha256 $UninstallerExecutable $IconPath
  $uninstallerEvidence = [ordered]@{
    signatureStatus = $uninstallerSignature
  }
}

[ordered]@{
  codeSigningConfigured = $false
  main = [ordered]@{
    signatureStatus = $mainSignature
  }
  installer = [ordered]@{
    signatureStatus = $installerSignature
  }
  uninstaller = $uninstallerEvidence
} | ConvertTo-Json -Depth 5 -Compress
